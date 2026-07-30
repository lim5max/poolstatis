import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_TEMPLATES,
  CORE_ANALYZE_CAPABILITIES,
  resolveTemplateCapability,
  validateAnalysisTemplate,
} from './templates';

describe('curated analysis templates', () => {
  it('ships eight unique, versioned and valid definitions', () => {
    expect(ANALYSIS_TEMPLATES).toHaveLength(8);
    expect(new Set(ANALYSIS_TEMPLATES.map((template) => template.key)).size).toBe(8);
    for (const template of ANALYSIS_TEMPLATES) {
      expect(template.version).toBe(1);
      expect(validateAnalysisTemplate(template)).toEqual({ valid: true, errors: [] });
      expect(JSON.stringify(template)).not.toContain('raw_event');
    }
  });

  it('maps capabilities fail-closed for this workstream', () => {
    expect(resolveTemplateCapability('product-health', CORE_ANALYZE_CAPABILITIES).status).toBe('available');
    expect(resolveTemplateCapability('activation-funnel', CORE_ANALYZE_CAPABILITIES).status).toBe('available');
    expect(resolveTemplateCapability('web-overview', CORE_ANALYZE_CAPABILITIES)).toMatchObject({
      status: 'unavailable',
      missing: ['web.analytics'],
    });
    expect(resolveTemplateCapability('release-impact', CORE_ANALYZE_CAPABILITIES).status).toBe('unavailable');
  });

  it('rejects invalid or raw-event slot definitions', () => {
    const invalid = {
      ...ANALYSIS_TEMPLATES[0],
      version: 0,
      requiredCapabilities: ['query.raw_event'],
      slots: [{ key: 'unsafe', resource: 'raw_event', required: true }],
      allowedActions: ['run_sql'],
    };
    const result = validateAnalysisTemplate(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/version|capability|resource|action/i);
  });
});
