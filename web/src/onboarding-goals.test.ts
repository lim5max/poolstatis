import { describe, expect, it } from 'vitest';
import { buildInstallationPack, onboardingGoalsForMode } from './onboardingGoals';

describe('onboarding goal presentation', () => {
  it('uses six task-oriented choices backed by real product sections', () => {
    expect(onboardingGoalsForMode('both')).toEqual([
      expect.objectContaining({ id: 'activation', title: 'Track a customer journey', sections: ['Funnels', 'People'] }),
      expect.objectContaining({ id: 'website_traffic', title: 'Understand website traffic', sections: ['Web', 'People'] }),
      expect.objectContaining({ id: 'feature_adoption', title: 'See what people use', sections: ['Product', 'Registry'] }),
      expect.objectContaining({ id: 'retention', title: 'Track a key outcome', sections: ['Home', 'Registry'] }),
      expect.objectContaining({ id: 'release', title: 'Measure a release', sections: ['Ship', 'Product'] }),
      expect.objectContaining({ id: 'reliability_performance', title: 'Monitor product quality', sections: ['Experience', 'Registry'] }),
    ]);
  });

  it('deduplicates installation sections without changing their first-seen order', () => {
    expect(buildInstallationPack(['activation', 'website_traffic', 'feature_adoption'])).toEqual({
      goals: ['Track a customer journey', 'Understand website traffic', 'See what people use'],
      sections: ['Funnels', 'People', 'Web', 'Product', 'Registry'],
    });
  });

  it('maps a website journey to the existing website-conversion intent', () => {
    expect(onboardingGoalsForMode('website')[0]).toEqual(expect.objectContaining({
      id: 'website_conversion',
      title: 'Track a customer journey',
    }));
  });
});
