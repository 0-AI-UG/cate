import { describe, it, expect } from 'vitest'
import { buildPlantumlArgs } from './plantuml'

describe('buildPlantumlArgs', () => {
  it('produces java -jar <jar> -tsvg -pipe', () => {
    expect(buildPlantumlArgs('/opt/plantuml.jar')).toEqual([
      '-jar',
      '/opt/plantuml.jar',
      '-tsvg',
      '-pipe',
    ])
  })
})
