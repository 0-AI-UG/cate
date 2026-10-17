// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { createTerritoryGL } from './territoryGL'

function webglHarness(fragmentPrecision = 23) {
  const loseContext = vi.fn()
  const gl = {
    FRAGMENT_SHADER: 1, VERTEX_SHADER: 2, HIGH_FLOAT: 3,
    COMPILE_STATUS: 4, LINK_STATUS: 5, ARRAY_BUFFER: 6, STATIC_DRAW: 7, FLOAT: 8,
    TEXTURE0: 9, TEXTURE1: 10, TEXTURE_2D: 11, TEXTURE_MIN_FILTER: 12,
    TEXTURE_MAG_FILTER: 13, TEXTURE_WRAP_S: 14, TEXTURE_WRAP_T: 15,
    NEAREST: 16, LINEAR: 17, CLAMP_TO_EDGE: 18, RGBA32F: 19, R8: 20,
    RED: 21, UNSIGNED_BYTE: 22, UNPACK_ALIGNMENT: 23, DEPTH_TEST: 24,
    BLEND: 25, FUNC_ADD: 26, ONE: 27, ONE_MINUS_SRC_ALPHA: 28,
    getShaderPrecisionFormat: vi.fn(() => ({ precision: fragmentPrecision })),
    createShader: vi.fn(() => ({})), shaderSource: vi.fn(), compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true), getShaderInfoLog: vi.fn(() => ''),
    deleteShader: vi.fn(), createProgram: vi.fn(() => ({})), attachShader: vi.fn(),
    bindAttribLocation: vi.fn(), linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true), getProgramInfoLog: vi.fn(() => ''),
    deleteProgram: vi.fn(), createVertexArray: vi.fn(() => ({})),
    bindVertexArray: vi.fn(), deleteVertexArray: vi.fn(),
    createBuffer: vi.fn(() => ({})), bindBuffer: vi.fn(), bufferData: vi.fn(),
    deleteBuffer: vi.fn(), enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(),
    getUniformLocation: vi.fn(() => ({})), createTexture: vi.fn(() => ({})),
    activeTexture: vi.fn(), bindTexture: vi.fn(), texParameteri: vi.fn(),
    texStorage2D: vi.fn(), texImage2D: vi.fn(), deleteTexture: vi.fn(),
    useProgram: vi.fn(), uniform1i: vi.fn(), pixelStorei: vi.fn(), disable: vi.fn(),
    enable: vi.fn(), blendEquation: vi.fn(), blendFunc: vi.fn(), clearColor: vi.fn(),
    getExtension: vi.fn((name: string) => name === 'WEBGL_lose_context' ? { loseContext } : null),
  } as unknown as WebGL2RenderingContext
  return { gl, loseContext }
}

it('releases the underlying context exactly once on dispose', () => {
  const { gl, loseContext } = webglHarness()
  const canvas = document.createElement('canvas')
  vi.spyOn(canvas, 'getContext').mockReturnValue(gl)

  const renderer = createTerritoryGL(canvas)
  expect(renderer).not.toBeNull()
  renderer?.dispose()
  renderer?.dispose()

  expect(gl.deleteTexture).toHaveBeenCalledTimes(2)
  expect(gl.deleteBuffer).toHaveBeenCalledTimes(1)
  expect(gl.deleteVertexArray).toHaveBeenCalledTimes(1)
  expect(gl.deleteProgram).toHaveBeenCalledTimes(1)
  expect(gl.getExtension).toHaveBeenCalledWith('WEBGL_lose_context')
  expect(loseContext).toHaveBeenCalledTimes(1)
})

it('releases a context when initialization falls back to the CPU', () => {
  const { gl, loseContext } = webglHarness(0)
  const canvas = document.createElement('canvas')
  vi.spyOn(canvas, 'getContext').mockReturnValue(gl)

  expect(createTerritoryGL(canvas)).toBeNull()
  expect(loseContext).toHaveBeenCalledTimes(1)
})
