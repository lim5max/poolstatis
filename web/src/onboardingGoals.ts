import type { ProjectGoalId, ProjectMode } from './api/types';

export type OnboardingGoalIcon = 'journey' | 'traffic' | 'usage' | 'outcome' | 'release' | 'quality';

export interface OnboardingGoalDefinition {
  id: ProjectGoalId;
  title: string;
  sections: string[];
  icon: OnboardingGoalIcon;
}

export interface InstallationPack {
  goals: string[];
  sections: string[];
}

const GOAL_PRESENTATION: Record<ProjectGoalId, Omit<OnboardingGoalDefinition, 'id'>> = {
  website_traffic: {
    title: 'Understand website traffic',
    sections: ['Web', 'People'],
    icon: 'traffic',
  },
  website_pages: {
    title: 'See which pages work',
    sections: ['Web', 'Registry'],
    icon: 'traffic',
  },
  website_conversion: {
    title: 'Track a customer journey',
    sections: ['Funnels', 'People'],
    icon: 'journey',
  },
  campaigns_referrals: {
    title: 'See where traffic comes from',
    sections: ['Web', 'People'],
    icon: 'traffic',
  },
  content_engagement: {
    title: 'See what content works',
    sections: ['Web', 'Registry'],
    icon: 'usage',
  },
  activation: {
    title: 'Track a customer journey',
    sections: ['Funnels', 'People'],
    icon: 'journey',
  },
  feature_adoption: {
    title: 'See what people use',
    sections: ['Product', 'Registry'],
    icon: 'usage',
  },
  retention: {
    title: 'Track a key outcome',
    sections: ['Home', 'Registry'],
    icon: 'outcome',
  },
  release: {
    title: 'Measure a release',
    sections: ['Ship', 'Product'],
    icon: 'release',
  },
  reliability_performance: {
    title: 'Monitor product quality',
    sections: ['Experience', 'Registry'],
    icon: 'quality',
  },
  custom: {
    title: 'Your own goal',
    sections: ['Registry'],
    icon: 'outcome',
  },
};

const SHARED_GOALS: ProjectGoalId[] = [
  'website_traffic',
  'feature_adoption',
  'retention',
  'release',
  'reliability_performance',
];

export function onboardingGoalsForMode(mode: ProjectMode): OnboardingGoalDefinition[] {
  const journey: ProjectGoalId = mode === 'website' ? 'website_conversion' : 'activation';
  return [journey, ...SHARED_GOALS].map((id) => ({ id, ...GOAL_PRESENTATION[id] }));
}

export function buildInstallationPack(goalIds: ProjectGoalId[]): InstallationPack {
  const goals: string[] = [];
  const sections: string[] = [];
  const seenGoals = new Set<string>();
  const seenSections = new Set<string>();

  for (const goalId of goalIds) {
    const goal = GOAL_PRESENTATION[goalId];
    if (!seenGoals.has(goal.title)) {
      seenGoals.add(goal.title);
      goals.push(goal.title);
    }
    for (const section of goal.sections) {
      if (seenSections.has(section)) continue;
      seenSections.add(section);
      sections.push(section);
    }
  }

  return { goals, sections };
}
