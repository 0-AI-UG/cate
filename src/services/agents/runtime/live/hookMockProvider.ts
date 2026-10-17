import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { crc32, gunzipSync } from 'node:zlib'

// Length-delimited protobuf field for Cursor's small Connect RPC fixtures.
function field(number: number, value: string | Buffer): Buffer {
  const bytes = Buffer.from(value)
  const varint = (value: number) => {
    const result: number[] = []
    do { result.push((value & 127) | (value > 127 ? 128 : 0)); value >>>= 7 } while (value)
    return Buffer.from(result)
  }
  return Buffer.concat([varint((number << 3) | 2), varint(bytes.length), bytes])
}

function byteFields(bytes: Buffer): Map<number, Buffer> {
  let offset = 0
  const readVarint = () => {
    let value = 0, shift = 0, byte: number
    do { byte = bytes[offset++]; value |= (byte & 127) << shift; shift += 7 } while (byte & 128)
    return value
  }
  const fields = new Map<number, Buffer>()
  while (offset < bytes.length) {
    const tag = readVarint()
    if ((tag & 7) === 0) readVarint()
    else if ((tag & 7) === 2) {
      const size = readVarint()
      fields.set(tag >>> 3, bytes.subarray(offset, offset + size)); offset += size
    } else break
  }
  return fields
}

// AWS event-stream framing used by Kiro's model response transport.
function awsEvent(event: string, payload: object): Buffer {
  const headers = Buffer.concat(Object.entries({ ':message-type': 'event', ':event-type': event, ':content-type': 'application/json' }).map(([name, value]) => {
    const size = Buffer.alloc(2)
    size.writeUInt16BE(Buffer.byteLength(value))
    return Buffer.concat([Buffer.from([name.length]), Buffer.from(name), Buffer.from([7]), size, Buffer.from(value)])
  }))
  const body = Buffer.from(JSON.stringify(payload))
  const prelude = Buffer.alloc(12)
  prelude.writeUInt32BE(16 + headers.length + body.length, 0)
  prelude.writeUInt32BE(headers.length, 4)
  prelude.writeUInt32BE(crc32(prelude.subarray(0, 8)), 8)
  const message = Buffer.concat([prelude, headers, body])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(message))
  return Buffer.concat([message, checksum])
}

/** Only the model transport is fake. The installed CLI owns the session,
 * terminal environment and hook execution; this server never posts a hook. */
export type MockHookReply =
  | { type: 'text'; hold?: boolean; text?: string }
  | { type: 'tool'; name: string; arguments: Record<string, unknown> | string; id?: string }
  | { type: 'error' }

export async function createHookMockProvider(options: {
  reply?: (input: Record<string, unknown>, protocol: string) => MockHookReply
} = {}) {
  const requests: string[] = []
  const modelInputs: Array<{ protocol: string; input: Record<string, unknown> }> = []
  const inputText: string[] = []
  let cursorToolFinished: (() => void) | undefined
  // Unpredictable and absent from the prompt: proves the CLI used this fixture,
  // rather than an accidentally inherited account or external model endpoint.
  const answer = `cate-${randomUUID().slice(0, 8)}`
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      const bytes = req.headers['content-encoding'] === 'gzip' ? gunzipSync(Buffer.concat(chunks)) : Buffer.concat(chunks)
      const body = bytes.toString('utf8')
      const route = new URL(req.url ?? '/', 'http://localhost').pathname
      requests.push(`${req.method} ${route}${req.headers['x-amz-target'] ? ` ${req.headers['x-amz-target']}` : ''}`)
      let input: Record<string, unknown> = {}
      if (!route.startsWith('/aiserver.v1.') && !route.startsWith('/agent.v1.')) {
        try { input = JSON.parse(body || '{}') } catch { res.writeHead(400); res.end(); return }
      }
      const inference = /\/(messages|chat\/completions|responses|generateAssistantResponse|RunSSE)$/.test(route)
        || req.headers['x-amz-target'] === 'KiroRuntimeService.GenerateAssistantResponse'
      const protocol = String(req.headers['x-amz-target'] ?? route)
      if (inference) {
        modelInputs.push({ protocol, input })
        inputText.push(body)
      }
      const reply = inference ? options.reply?.(input, protocol) ?? { type: 'text' } : { type: 'text' } as MockHookReply
      if (reply.type === 'error') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Cate lifecycle fixture: deliberate provider failure' } }))
        return
      }
      const call = reply.type === 'tool' ? { id: reply.id ?? 'call_cate_lifecycle', name: reply.name, arguments: reply.arguments } : undefined
      const hold = reply.type === 'text' && reply.hold
      const finish = () => { if (!hold) res.end() }
      const replyText = reply.type === 'text' ? reply.text ?? answer : answer
      const model = input.model ?? 'cate-mock'
      const json = (value: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
      const sse = (value: unknown, event?: string) => res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(value)}\n\n`)
      if (route === '/generateAssistantResponse' || req.headers['x-amz-target'] === 'KiroRuntimeService.GenerateAssistantResponse') {
        res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' })
        if (call) {
          res.write(awsEvent('toolUseEvent', { toolUseId: call.id, name: call.name, input: JSON.stringify(call.arguments), stop: true }))
        } else res.write(awsEvent('assistantResponseEvent', { content: replyText, modelId: 'auto' }))
        finish()
      } else if (route === '/') {
        const kiroModel = { modelId: 'auto', modelName: 'Cate mock', description: 'Local fixture', status: 'ACTIVE', modelProvider: 'ANTHROPIC', rateMultiplier: 1, tokenLimits: { maxInputTokens: 100000, maxOutputTokens: 4096 } }
        json({ models: [kiroModel], defaultModel: kiroModel })
      } else if (route === '/auth/exchange_user_api_key') {
        const token = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'cate-test', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.mock`
        json({ accessToken: token, refreshToken: token })
      } else if (route === '/agent.v1.AgentService/RunSSE') {
        res.writeHead(200, { 'content-type': 'application/connect+proto' })
        const frame = (message: Buffer, flags = 0) => {
          const header = Buffer.alloc(5)
          header[0] = flags
          header.writeUInt32BE(message.length, 1)
          res.write(Buffer.concat([header, message]))
        }
        const complete = () => {
          frame(field(1, field(1, field(1, replyText)))) // interaction_update.text_delta.text
          if (hold) return
          frame(field(1, field(14, Buffer.alloc(0)))) // interaction_update.turn_ended
          frame(Buffer.from('{}'), 2) // Connect end-of-stream envelope
          res.end()
        }
        if (call && typeof call.arguments === 'object') {
          cursorToolFinished = complete
          const args = call.arguments
          const write = Buffer.concat([field(1, String(args.path)), field(2, String(args.text)), field(3, call.id)])
          frame(field(2, Buffer.concat([Buffer.from([8, 1]), field(15, 'cate-exec-result'), field(3, write)])))
        } else complete()
      } else if (route.startsWith('/aiserver.v1.')) {
        if (route.endsWith('/BidiAppend')) {
          const fields = byteFields(bytes)
          const message = fields.get(4) ?? Buffer.from(fields.get(1)?.toString() ?? '', 'hex')
          inputText.push(message.toString('utf8'))
          if (byteFields(message).has(2)) { // AgentClientMessage.exec_client_message
            cursorToolFinished?.()
            cursorToolFinished = undefined
          }
        }
        res.writeHead(200, { 'content-type': 'application/proto' })
        res.end(route.endsWith('/GetServerConfig') ? Buffer.from([56, 1]) : /\/(GetUsableModels|GetDefaultModelForCli)$/.test(route)
          ? field(1, Buffer.concat([field(1, 'auto'), field(4, 'Cate mock')])) : undefined)
      } else if (route.endsWith('/models')) {
        json({ object: 'list', data: [{ id: 'cate-mock', object: 'model', owned_by: 'cate', created: 1 }] })
      } else if (route.endsWith('/messages/count_tokens')) {
        json({ input_tokens: 10 })
      } else if (route.endsWith('/messages')) {
        const message = { id: 'msg_cate', type: 'message', role: 'assistant', model,
          content: call ? [{ type: 'tool_use', id: call.id, name: call.name, input: call.arguments }] : [{ type: 'text', text: replyText }], stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 3 } }
        if (!input.stream) { json(message); return }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        sse({ type: 'message_start', message: { ...message, content: [], stop_reason: null } }, 'message_start')
        sse({ type: 'content_block_start', index: 0, content_block: call ? { type: 'tool_use', id: call.id, name: call.name, input: {} } : { type: 'text', text: '' } }, 'content_block_start')
        sse({ type: 'content_block_delta', index: 0, delta: call ? { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments) } : { type: 'text_delta', text: replyText } }, 'content_block_delta')
        if (hold) return
        sse({ type: 'content_block_stop', index: 0 }, 'content_block_stop')
        sse({ type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }, 'message_delta')
        sse({ type: 'message_stop' }, 'message_stop')
        res.end()
      } else if (route.endsWith('/chat/completions')) {
        const base = { id: 'chatcmpl-cate', created: 1, model }
        const toolCalls = call ? [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] : undefined
        const message = toolCalls ? { role: 'assistant', content: null, tool_calls: toolCalls } : { role: 'assistant', content: replyText }
        const reason = call ? 'tool_calls' : 'stop'
        if (!input.stream) {
          json({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: reason }],
            usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const delta = toolCalls ? { role: 'assistant', tool_calls: toolCalls.map((tool) => ({ index: 0, ...tool })) } : message
        sse({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })
        if (hold) return
        sse({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })
        res.end('data: [DONE]\n\n')
      } else if (route.endsWith('/responses')) {
        const part = { type: 'output_text', text: replyText, annotations: [], logprobs: [] }
        const item = call
          ? { id: call.id, call_id: call.id, type: typeof call.arguments === 'string' ? 'custom_tool_call' : 'function_call', status: 'completed', name: call.name,
            ...(typeof call.arguments === 'string' ? { input: call.arguments } : { arguments: JSON.stringify(call.arguments) }) }
          : { id: 'msg_cate', type: 'message', status: 'completed', role: 'assistant', content: [part] }
        const response = { id: 'resp_cate', object: 'response', created_at: 1, status: 'completed', model,
          output: [item], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13,
            input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }
        if (!input.stream) { json(response); return }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        let sequence = 0
        const send = (type: string, fields: object) => sse({ type, sequence_number: sequence++, ...fields }, type)
        send('response.created', { response: { ...response, status: 'in_progress', output: [] } })
        send('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
        if (call) {
          const custom = typeof call.arguments === 'string'
          const data = custom ? call.arguments : JSON.stringify(call.arguments)
          send(custom ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: data })
          send(custom ? 'response.custom_tool_call_input.done' : 'response.function_call_arguments.done', { item_id: item.id, output_index: 0, name: call.name, arguments: data, input: data })
          send('response.output_item.done', { output_index: 0, item })
          send('response.completed', { response })
          res.end()
          return
        }
        send('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: '' } })
        send('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: replyText })
        if (hold) return
        send('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: replyText })
        send('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part })
        send('response.output_item.done', { output_index: 0, item })
        send('response.completed', { response })
        res.end()
      } else {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: `Unexpected mock provider route: ${route}` }))
      }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    modelInputs,
    inputText,
    answer,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}
