import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(process.cwd());
const POLICY_FILE = 'src/greenColorPolicy.test.ts';
const TEXT_EXTENSIONS = new Set(['.css', '.html', '.svg', '.ts', '.tsx']);
const COLOR_UTILITY_PREFIXES = [
  'accent', 'bg', 'border(?:-[xytrbl])?', 'caret', 'decoration', 'divide(?:-[xy])?',
  'drop-shadow', 'fill', 'from', 'inset-ring(?:-offset)?', 'inset-shadow', 'marker',
  'outline', 'placeholder', 'ring(?:-offset)?', 'shadow', 'stroke', 'text', 'text-shadow',
  'to', 'via',
];
const COLOR_UTILITY_PREFIX = `(?:${COLOR_UTILITY_PREFIXES.join('|')})`;
const GREEN_NAME = '(?:aquamarine|chartreuse|darkgreen|darkolivegreen|darkseagreen|emerald|forestgreen|green|greenyellow|lawngreen|lightgreen|lightseagreen|lime|limegreen|mediumaquamarine|mediumseagreen|mediumspringgreen|olivedrab|olive|palegreen|seagreen|springgreen|yellowgreen)';
const GREEN_UTILITY = new RegExp(`(?:^|[^\\w-])${COLOR_UTILITY_PREFIX}-(?:emerald|green|lime)-\\d{2,3}(?:/\\d{1,3})?`, 'gi');
const ARBITRARY_GREEN_UTILITY = new RegExp(`${COLOR_UTILITY_PREFIX}-\\[${GREEN_NAME}\\]`, 'gi');
const TRANSLUCENT_FOCUS_RING = /(?:focus-visible|has-focus-visible):ring-ring\/\d{1,3}/gi;
const HEX_COLOR = /#[\da-f]{3,8}\b/gi;
const RAW_COLOR_FUNCTION = /(?:rgba?|hsla?|oklch|oklab)\s*\(/gi;
const RAW_NAMED_GREEN = new RegExp(`(?:color|background(?:-color|Color)?|border(?:-color|Color)?|fill|stroke)\\s*:\\s*['"]?${GREEN_NAME}\\b['"]?`, 'gi');
const GREEN_TEXT_TOKEN = /(?:^|[^\w-])text-(?:brand(?:-strong)?|primary|success)(?:\/\d{1,3})?(?=$|[^\w-])/g;

// These colors are content rather than interface state. Keep the allowlist exact:
// a new literal or a second occurrence still fails the policy.
const RAW_GREEN_EXCEPTIONS: Record<string, Record<string, number>> = {
  'public/poolstatis-logo.svg': { '#B9F542': 1 },
  'src/components/logos/google.tsx': { '#34A853': 1 },
  'src/components/logos/windsurf.tsx': { '#34E8BB': 1 },
  'src/lightVisualSystem.test.ts': { '#b9f542': 1 },
  'src/metric-taxonomy.test.tsx': { '#16A34A': 1 },
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    if (entry === 'dist' || entry === 'node_modules') return [];
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : TEXT_EXTENSIONS.has(extname(entry))
        ? [path]
        : [];
  });
}

function normalizedHex(hex: string): string {
  const value = hex.slice(1);
  const expanded = value.length === 3 || value.length === 4
    ? [...value].map((digit) => digit + digit).join('')
    : value;
  return `#${expanded.slice(0, 6).toUpperCase()}`;
}

function rgb(hex: string): [number, number, number] {
  const value = normalizedHex(hex);
  return [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16)) as [number, number, number];
}

function hueAndSaturation(hex: string): { hue: number; saturation: number } {
  const [red, green, blue] = rgb(hex).map((value) => value / 255) as [number, number, number];
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const lightness = (max + min) / 2;
  if (delta === 0) return { hue: 0, saturation: 0 };

  let hue = max === red
    ? 60 * (((green - blue) / delta) % 6)
    : max === green
      ? 60 * ((blue - red) / delta + 2)
      : 60 * ((red - green) / delta + 4);
  if (hue < 0) hue += 360;
  return {
    hue,
    saturation: delta / (1 - Math.abs(2 * lightness - 1)),
  };
}

function isRawGreen(hex: string): boolean {
  const { hue, saturation } = hueAndSaturation(hex);
  return saturation >= 0.2 && hue >= 65 && hue <= 175;
}

function luminance(hex: string): number {
  const [red, green, blue] = rgb(hex)
    .map((value) => value / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first: string, second: string): number {
  const firstLuminance = luminance(first);
  const secondLuminance = luminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function themeBlock(css: string, selector: ':root' | '.dark'): string {
  const match = css.match(new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`Missing ${selector} theme block`);
  return match[1]!;
}

function token(block: string, name: string): string {
  const match = block.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`Missing --${name}`);
  return match[1]!.trim();
}

describe('green color policy', () => {
  it('keeps interface greens behind brand and semantic tokens', () => {
    const violations: string[] = [];
    const exceptionHits: Record<string, Record<string, number>> = {};

    for (const path of sourceFiles(ROOT)) {
      const file = relative(ROOT, path);
      if (file === 'src/index.css' || file === POLICY_FILE) continue;
      const source = readFileSync(path, 'utf8');

      for (const match of source.matchAll(GREEN_UTILITY)) {
        violations.push(`${file}: raw utility ${match[0].trim()}`);
      }
      for (const match of source.matchAll(ARBITRARY_GREEN_UTILITY)) {
        violations.push(`${file}: raw arbitrary utility ${match[0]}`);
      }
      for (const match of source.matchAll(RAW_COLOR_FUNCTION)) {
        violations.push(`${file}: raw color function ${match[0]}`);
      }
      for (const match of source.matchAll(RAW_NAMED_GREEN)) {
        violations.push(`${file}: raw named green ${match[0]}`);
      }
      for (const match of source.matchAll(TRANSLUCENT_FOCUS_RING)) {
        violations.push(`${file}: translucent focus ring ${match[0]}`);
      }
      for (const match of source.matchAll(HEX_COLOR)) {
        if (!isRawGreen(match[0])) continue;
        const allowed = RAW_GREEN_EXCEPTIONS[file]?.[match[0]];
        if (!allowed) {
          violations.push(`${file}: raw green ${match[0]}`);
          continue;
        }
        exceptionHits[file] ??= {};
        exceptionHits[file][match[0]] = (exceptionHits[file][match[0]] ?? 0) + 1;
      }
    }

    expect(violations, violations.join('\n')).toEqual([]);
    expect(exceptionHits).toEqual(RAW_GREEN_EXCEPTIONS);
  });

  it('recognizes utility and arbitrary-color bypasses', () => {
    for (const prefix of COLOR_UTILITY_PREFIXES) {
      const concretePrefix = prefix.replace(/\(\?:-[^)]+\)\?/g, '');
      expect(`${concretePrefix}-green-500`).toMatch(GREEN_UTILITY);
    }
    for (const source of ['bg-[green]', 'placeholder-[green]', 'marker-[forestgreen]', 'bg-[lightseagreen]']) {
      expect(source).toMatch(ARBITRARY_GREEN_UTILITY);
    }
    expect('bg-[rgb(0_255_0)]').toMatch(RAW_COLOR_FUNCTION);
    expect("style={{ color: 'green' }}").toMatch(RAW_NAMED_GREEN);
    expect("style={{ backgroundColor: 'forestgreen' }}").toMatch(RAW_NAMED_GREEN);
    expect("style={{ backgroundColor: 'mediumaquamarine' }}").toMatch(RAW_NAMED_GREEN);
    expect("style={{ borderColor: 'aquamarine' }}").toMatch(RAW_NAMED_GREEN);
  });

  it('keeps brand and success lime out of body text', () => {
    const violations: string[] = [];
    for (const path of sourceFiles(resolve(ROOT, 'src'))) {
      const file = relative(ROOT, path);
      if (file === POLICY_FILE || /\.(?:test|spec)\.[^.]+$/.test(file)) continue;
      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(GREEN_TEXT_TOKEN)) {
        violations.push(`${file}: green text token ${match[0].trim()}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('recognizes green text tokens without rejecting foreground pair tokens', () => {
    for (const source of ['text-brand', 'text-brand-strong', 'text-brand/80', 'text-primary', 'hover:text-primary/80', 'text-success', 'text-success/75']) {
      expect(source).toMatch(GREEN_TEXT_TOKEN);
    }
    for (const source of ['text-success-foreground', 'text-brand-foreground', 'text-primary-foreground', 'text-muted-foreground']) {
      expect(source).not.toMatch(GREEN_TEXT_TOKEN);
    }
  });

  it('derives success from the primary lime hue with AA contrast in both themes', () => {
    const css = readFileSync(resolve(ROOT, 'src/index.css'), 'utf8');

    for (const selector of [':root', '.dark'] as const) {
      const block = themeBlock(css, selector);
      const primary = token(block, 'brand-lime');
      const primaryForeground = token(block, 'brand-foreground');
      const success = token(block, 'brand-lime-strong');
      const successForeground = token(block, 'success-foreground');
      const background = token(block, 'background');
      const hueDistance = Math.abs(hueAndSaturation(primary).hue - hueAndSaturation(success).hue);

      expect(token(block, 'success')).toBe('var(--brand-lime-strong)');
      expect(hueDistance).toBeLessThanOrEqual(8);
      expect(contrast(primary, primaryForeground)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(success, successForeground)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(success, background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps keyboard focus neutral instead of spending the brand color on every field', () => {
    const css = readFileSync(resolve(ROOT, 'src/index.css'), 'utf8');

    for (const selector of [':root', '.dark'] as const) {
      const block = themeBlock(css, selector);
      const ring = token(block, 'ring');
      const background = token(block, 'background');

      expect(isRawGreen(ring), `${selector} ring should be neutral`).toBe(false);
      expect(contrast(ring, background), `${selector} ring contrast`).toBeGreaterThanOrEqual(3);
      expect(token(block, 'sidebar-ring')).toBe(ring);
    }
  });
});
