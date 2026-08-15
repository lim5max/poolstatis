export interface ReplayPrivacyPolicy {
  version: string;
  text: 'masked' | 'visible';
  maskSelectors?: string[];
  blockSelectors?: string[];
}

const SAFE_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const ROUTE = /^[a-z][a-z0-9_.:-]{0,119}$/;
const HOST = /^(?:localhost|(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,62}[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,62}[a-zA-Z0-9])?))*)$/;
const SECRET = /(?:bearer\s+[a-z0-9._~-]+|(?:sk|pk|pt)_[a-f0-9]{12,}|eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}|\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b|\b(?:\d[ -]*?){13,19}\b)/gi;
const URL = /(?:https?:\/\/|javascript:|data:|blob:|url\s*\()/i;
const RELATIVE_LOCATION = /^\s*(?:\/|\.{1,2}\/|\?|#)/;
const LOCATION_KEY = /^(?:url|uri|path|pathname|search|hash|location|baseurl)$/i;
const NETWORK_ATTRIBUTE = /^(?:src|srcset|href|action|formaction|poster|background|ping|integrity|nonce|crossorigin|referrerpolicy|srcdoc)$/i;
const SAFE_ATTRIBUTE = /^(?:class|id|role|aria-[a-z-]+|title|alt|type|name|placeholder|style|_csstext|disabled|checked|selected|readonly|multiple|tabindex|colspan|rowspan|width|height|contenteditable|data-poolstatis-replay-blocked)$/i;
const CANONICAL_STRUCTURAL_TOKEN = /^rr-[0-9a-f]{8}$/i;
const BOOLEAN_ATTRIBUTE = /^(?:disabled|checked|selected|readonly|multiple)$/i;
const NUMERIC_ATTRIBUTE = /^(?:tabindex|colspan|rowspan|width|height)$/i;
const SAFE_ROLE = /^(?:button|link|dialog|main|navigation|banner|contentinfo|region|heading|list|listitem|img|presentation|none|status|alert|tab|tabpanel|textbox|checkbox|radio|menu|menuitem|progressbar|slider|switch|table|row|cell)$/i;
const SAFE_INPUT_TYPE = /^(?:button|submit|reset|text|checkbox|radio|range|number|date|time|search)$/i;
const SIMPLE_SELECTOR = /^(?:[a-z][a-z0-9-]*|[.#][a-zA-Z_][a-zA-Z0-9_-]*|\[[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:="[a-zA-Z0-9_.:-]{1,80}")?\])$/;
const SAFE_CSS_PROPERTY = /^(?:display|position|top|right|bottom|left|inset(?:-(?:block|inline)(?:-(?:start|end))?)?|z-index|float|clear|overflow(?:-[xy])?|visibility|opacity|box-sizing|width|min-width|max-width|height|min-height|max-height|margin(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|padding(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-(?:width|style|color))?|border-radius|border-collapse|border-spacing|outline(?:-(?:width|style|color|offset))?|flex(?:-(?:basis|direction|flow|grow|shrink|wrap))?|align-(?:content|items|self)|justify-(?:content|items|self)|place-(?:content|items|self)|gap|row-gap|column-gap|grid(?:-(?:auto-columns|auto-flow|auto-rows|column|column-end|column-gap|column-start|gap|row|row-end|row-gap|row-start|template-columns|template-rows))?|order|columns|column-count|column-width|object-fit|object-position|transform|transform-origin|translate|rotate|scale|font-size|font-style|font-weight|font-stretch|line-height|letter-spacing|word-break|word-spacing|overflow-wrap|white-space|text-align|text-decoration(?:-(?:color|line|style|thickness))?|text-transform|text-overflow|text-indent|color|background-color|box-shadow|vertical-align|list-style-position|list-style-type|table-layout|pointer-events|user-select|aspect-ratio|scroll-behavior|scroll-margin(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|scroll-padding(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|overscroll-behavior(?:-[xy])?)$/i;
const FIXED_BLOCK_SELECTORS = [
  '[data-poolstatis-block]',
  '.rr-block',
  'input[type="password"]',
  'input[type="hidden"]',
  'input[autocomplete*="cc-"]',
  'input[autocomplete*="password"]',
  'input[autocomplete="one-time-code"]',
  '[data-payment]',
  '[data-auth-token]',
];
const FIXED_MASK_SELECTORS = [
  '[data-poolstatis-mask]',
  '.rr-mask',
  'input',
  'textarea',
  '[contenteditable]:not([contenteditable="false"])',
];

export function assertReplayPolicy(
  policy: ReplayPrivacyPolicy,
  allowedHosts: string[],
  currentHost: string,
  route: string,
): void {
  if (!SAFE_KEY.test(policy.version)) throw new Error('replay policy version must be a stable identifier');
  if (policy.text !== 'masked' && policy.text !== 'visible') throw new Error('replay text policy must be masked or visible');
  if (!ROUTE.test(route)) throw new Error('replay route must be a finite developer-provided key, never a raw URL');
  if (allowedHosts.length < 1 || allowedHosts.length > 20
      || allowedHosts.some((host) => !HOST.test(host) || host.includes('*'))) {
    throw new Error('replay allowedHosts must contain exact hostnames without schemes, ports or wildcards');
  }
  if (!allowedHosts.includes(currentHost)) throw new Error('current host is not allowed by replay host policy');
  for (const selectors of [policy.maskSelectors ?? [], policy.blockSelectors ?? []]) {
    if (selectors.length > 20 || selectors.some((selector) => !SIMPLE_SELECTOR.test(selector))) {
      throw new Error('replay selectors must be bounded simple tag, class, id or attribute selectors');
    }
  }
}

export function rrwebPrivacyOptions(policy: ReplayPrivacyPolicy) {
  return {
    blockSelector: [...FIXED_BLOCK_SELECTORS, ...(policy.blockSelectors ?? [])].join(','),
    maskTextSelector: [...FIXED_MASK_SELECTORS, ...(policy.maskSelectors ?? [])].join(','),
    maskAllText: policy.text === 'masked',
    maskAllInputs: true,
    recordCanvas: false,
    recordCrossOriginIframes: false,
    inlineImages: false,
    collectFonts: false,
  } as const;
}

/** Second client-side pass; the server repeats a stricter independent pass. */
export function sanitizeRecordedEvent(event: unknown, policy: ReplayPrivacyPolicy, route: string): unknown {
  const copy = clone(event, {
    textMode: policy.text,
    route,
    forceMask: false,
    cssText: false,
    cssRule: false,
    maskSelectors: policy.maskSelectors ?? [],
    blockSelectors: policy.blockSelectors ?? [],
    key: '',
  });
  if (isObject(copy) && isObject(copy.data) && copy.data.source === 5 && typeof copy.data.text === 'string') {
    copy.data.text = mask(copy.data.text);
  }
  return copy;
}

interface CloneContext {
  textMode: 'masked' | 'visible';
  route: string;
  forceMask: boolean;
  cssText: boolean;
  cssRule: boolean;
  maskSelectors: string[];
  blockSelectors: string[];
  key: string;
}

function clone(value: unknown, context: CloneContext): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (context.key === '_cssText' || context.key === 'cssText' || context.key === 'rule'
        || context.cssRule && (context.key === 'replace' || context.key === 'replaceSync')
        || context.cssText && context.key === 'textContent') {
      return sanitizeCssStylesheet(value);
    }
    if (context.key === 'href') return `https://replay.invalid/${context.route}`;
    if (LOCATION_KEY.test(context.key)) return '••••';
    if ((context.key === 'textContent' || context.key === 'value' || context.key === 'text')
        && (context.forceMask || context.textMode === 'masked')) return mask(value);
    if (context.textMode === 'masked') return mask(value);
    if (URL.test(value)) return '••••';
    URL.lastIndex = 0;
    if (RELATIVE_LOCATION.test(value)) return '••••';
    const redacted = value.replace(SECRET, '••••');
    SECRET.lastIndex = 0;
    return redacted;
  }
  if (Array.isArray(value)) return value.map((item) => clone(item, context));
  if (!isObject(value)) return null;
  const tagName = typeof value.tagName === 'string' ? value.tagName.toLowerCase() : '';
  const attributes = isObject(value.attributes) ? value.attributes : {};
  // A real DOM cannot expose case-fold duplicate attribute names, but crafted
  // rrweb JSON can. Block the whole node so selector lookup and normalized
  // output cannot disagree about which value wins.
  const blocked = hasCaseFoldDuplicateAttributes(attributes)
    || tagName !== '' && isBlockedNode(value, context.blockSelectors);
  const executable = blocked || ['script', 'iframe', 'object', 'embed', 'form', 'base', 'meta'].includes(tagName);
  const contentEditable = attributeValues(attributes, 'contenteditable').some((candidate) => (
    candidate !== false
    && !(typeof candidate === 'string' && candidate.toLowerCase() === 'false')
  ));
  const forceMask = context.forceMask
    || tagName === 'input'
    || tagName === 'textarea'
    || contentEditable
    || value.source === 5
    || tagName !== '' && isMaskedNode(value, context.maskSelectors);
  const cssText = context.cssText || value.isStyle === true || tagName === 'style';
  const cssRule = context.cssRule || value.source === 8 || value.source === 15;
  const styleDeclaration = value.source === 13;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor' || /^on/i.test(key)) continue;
    if (key === 'tagName') {
      output.tagName = executable ? 'div' : tagName;
      continue;
    }
    if (key === 'attributes' && isObject(child)) {
      const safe: Record<string, unknown> = {};
      for (const [name, attribute] of Object.entries(child)) {
        const lower = name.toLowerCase();
        if (/^on/i.test(name) || NETWORK_ATTRIBUTE.test(name) || lower === 'value'
          || lower.startsWith('data-') && lower !== 'data-poolstatis-replay-blocked'
          || !SAFE_ATTRIBUTE.test(lower)) continue;
        const value = String(attribute).slice(0, 2_000);
        const outputName = lower === '_csstext' ? '_cssText' : lower;
        if (lower === 'id' || lower === 'class') {
          safe[outputName] = structuralTokens(value);
        } else if (lower === 'name' || lower === 'title' || lower === 'alt' || lower === 'placeholder'
          || lower.startsWith('aria-') && lower !== 'aria-hidden') {
          safe[outputName] = '••••';
        } else if (lower === 'style') {
          safe[outputName] = sanitizeCssDeclarations(value);
        } else if (lower === '_csstext') {
          safe[outputName] = sanitizeCssStylesheet(value);
        } else if (BOOLEAN_ATTRIBUTE.test(lower)) {
          if (attribute === true || value === '' || value.toLowerCase() === lower) safe[outputName] = '';
        } else if (NUMERIC_ATTRIBUTE.test(lower)) {
          if (/^-?\d{1,6}$/.test(value)) {
            const numeric = Number(value);
            if (Number.isSafeInteger(numeric) && numeric >= -1 && numeric <= 100_000) safe[outputName] = String(numeric);
          }
        } else if (lower === 'contenteditable') {
          safe[outputName] = value.toLowerCase() === 'false' ? 'false' : 'true';
        } else if (lower === 'aria-hidden') {
          safe[outputName] = /^(?:true|false)$/i.test(value) ? value.toLowerCase() : '••••';
        } else if (lower === 'role') {
          safe[outputName] = SAFE_ROLE.test(value) ? value.toLowerCase() : '••••';
        } else if (lower === 'type') {
          safe[outputName] = SAFE_INPUT_TYPE.test(value) ? value.toLowerCase() : '••••';
        } else {
          safe[outputName] = clone(attribute, { ...context, forceMask, key: lower });
        }
      }
      output.attributes = executable ? { 'data-poolstatis-replay-blocked': 'true' } : safe;
      continue;
    }
    if (styleDeclaration && key === 'set' && isObject(child)) {
      const set = sanitizeStyleDeclarationSet(child);
      if (set) output.set = set;
      continue;
    }
    if (styleDeclaration && key === 'remove' && isObject(child)) {
      const remove = sanitizeStyleDeclarationRemove(child);
      if (remove) output.remove = remove;
      continue;
    }
    if (executable && (key === 'childNodes' || key === 'textContent')) {
      output[key] = key === 'childNodes' ? [] : '';
      continue;
    }
    output[key] = clone(child, {
      ...context,
      forceMask,
      key,
      cssText,
      cssRule,
    });
  }
  return output;
}

function sanitizeStyleDeclarationSet(input: Record<string, any>): Record<string, string | null> | null {
  if (typeof input.property !== 'string' || input.value !== null && typeof input.value !== 'string') return null;
  const declaration = sanitizeCssDeclarations(`${input.property}:${input.value ?? ''}`);
  const colon = declaration.indexOf(':');
  if (colon <= 0) return null;
  return {
    property: declaration.slice(0, colon),
    value: input.value === null ? null : declaration.slice(colon + 1),
    priority: input.priority === 'important' ? 'important' : '',
  };
}

function sanitizeStyleDeclarationRemove(input: Record<string, any>): { property: string } | null {
  if (typeof input.property !== 'string') return null;
  let property = input.property.trim().toLowerCase();
  if (property.startsWith('--')) property = canonicalCustomProperty(property);
  else if (!SAFE_CSS_PROPERTY.test(property)) return null;
  return { property };
}

function isBlockedNode(node: Record<string, any>, selectors: string[]): boolean {
  const tagName = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : '';
  const attributes = isObject(node.attributes) ? node.attributes : {};
  const inputIsSensitive = attributeValues(attributes, 'type').some((value) => (
    typeof value === 'string' && ['password', 'hidden'].includes(value.toLowerCase())
  )) || attributeValues(attributes, 'autocomplete').some((value) => {
    if (typeof value !== 'string') return false;
    const normalized = value.toLowerCase();
    return normalized.includes('cc-') || normalized.includes('password') || normalized === 'one-time-code';
  });
  return hasAttribute(attributes, 'data-poolstatis-replay-blocked')
    || hasAttribute(attributes, 'data-poolstatis-block')
    || classTokens(attributes).includes('rr-block')
    || tagName === 'input' && inputIsSensitive
    || hasAttribute(attributes, 'data-payment')
    || hasAttribute(attributes, 'data-auth-token')
    || selectors.some((selector) => matchesSimpleSelector(node, selector));
}

function isMaskedNode(node: Record<string, any>, selectors: string[]): boolean {
  const tagName = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : '';
  const attributes = isObject(node.attributes) ? node.attributes : {};
  return tagName === 'input'
    || tagName === 'textarea'
    || hasAttribute(attributes, 'data-poolstatis-mask')
    || classTokens(attributes).includes('rr-mask')
    || selectors.some((selector) => matchesSimpleSelector(node, selector));
}

function matchesSimpleSelector(node: Record<string, any>, selector: string): boolean {
  const attributes = isObject(node.attributes) ? node.attributes : {};
  const tagName = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : '';
  if (selector.startsWith('.')) return classTokens(attributes).includes(selector.slice(1));
  if (selector.startsWith('#')) {
    return attributeValues(attributes, 'id').some((value) => String(value) === selector.slice(1));
  }
  const attribute = selector.match(/^\[([a-zA-Z_:][a-zA-Z0-9_.:-]*)(?:="([a-zA-Z0-9_.:-]{1,80})")?\]$/);
  if (attribute) {
    const values = attributeValues(attributes, attribute[1]!);
    return values.length > 0 && (attribute[2] === undefined
      || values.some((value) => String(value) === attribute[2]));
  }
  return tagName === selector.toLowerCase();
}

function hasAttribute(attributes: Record<string, any>, name: string): boolean {
  return attributeValues(attributes, name).length > 0;
}

function attributeValues(attributes: Record<string, any>, name: string): unknown[] {
  const normalized = name.toLowerCase();
  return Object.entries(attributes)
    .filter(([candidate]) => candidate.toLowerCase() === normalized)
    .map(([, value]) => value);
}

function classTokens(attributes: Record<string, any>): string[] {
  return attributeValues(attributes, 'class').flatMap((value) => (
    typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : []
  ));
}

function hasCaseFoldDuplicateAttributes(attributes: Record<string, any>): boolean {
  const names = new Set<string>();
  for (const name of Object.keys(attributes)) {
    const normalized = name.toLowerCase();
    if (names.has(normalized)) return true;
    names.add(normalized);
  }
  return false;
}

function mask(value: string): string {
  return value.replace(/\S/g, '•');
}

function structuralTokens(value: string): string {
  return value.split(/\s+/).filter(Boolean).slice(0, 20).map(canonicalStructuralToken).join(' ');
}

function canonicalStructuralToken(token: string): string {
  if (CANONICAL_STRUCTURAL_TOKEN.test(token)) return token.toLowerCase();
  return `rr-${fnv1a(token)}`;
}

function canonicalCustomProperty(property: string): string {
  if (/^--rr-[0-9a-f]{8}$/i.test(property)) return property.toLowerCase();
  return `--rr-${fnv1a(property.slice(2))}`;
}

function sanitizeCssStylesheet(input: string, depth = 0): string {
  if (depth > 6) return '';
  const css = input.slice(0, 100_000)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@(?:import|charset|namespace)[^;{}]*;?/gi, '');
  let cursor = 0;
  let output = '';
  while (cursor < css.length) {
    const open = findCssBrace(css, cursor, '{');
    if (open < 0) break;
    const close = matchingCssBrace(css, open);
    if (close < 0) break;
    const prelude = css.slice(cursor, open).trim();
    const body = css.slice(open + 1, close);
    if (/^@(media|supports|container|layer)\b/i.test(prelude)) {
      const safePrelude = sanitizeCssAtRulePrelude(prelude);
      const safeBody = sanitizeCssStylesheet(body, depth + 1);
      if (safePrelude && safeBody) output += `${safePrelude}{${safeBody}}`;
    } else if (!prelude.startsWith('@')) {
      const selector = sanitizeCssSelector(prelude);
      const declarations = sanitizeCssDeclarations(body);
      if (selector && declarations) output += `${selector}{${declarations}}`;
    }
    cursor = close + 1;
  }
  return output;
}

function sanitizeCssSelector(input: string): string {
  const selectors = input.split(',').map((candidate) => candidate.trim()).filter((candidate) => (
    candidate.length > 0
    && candidate.length <= 2_000
    && !/[\[\]"'\\@{};]/.test(candidate)
    && /^[a-zA-Z0-9*_.#:(),\s>+~/-]+$/.test(candidate)
  )).map((candidate) => candidate.replace(/([.#])([a-zA-Z_][a-zA-Z0-9_-]*)/g, (_match, prefix: string, token: string) => (
    `${prefix}${canonicalStructuralToken(token)}`
  )));
  return selectors.slice(0, 100).join(',');
}

function sanitizeCssAtRulePrelude(input: string): string {
  if (!/^@(media|supports|container|layer)\b/i.test(input) || input.length > 2_000) return '';
  if (!/^[a-zA-Z0-9@\s():.,/%+_-]+$/.test(input) || URL.test(input)) return '';
  URL.lastIndex = 0;
  const result = input.replace(SECRET, '••••');
  SECRET.lastIndex = 0;
  return result;
}

function sanitizeCssDeclarations(input: string): string {
  const declarations: string[] = [];
  for (const raw of splitCssDeclarations(input)) {
    const colon = raw.indexOf(':');
    if (colon <= 0) continue;
    let property = raw.slice(0, colon).trim().toLowerCase();
    let value = raw.slice(colon + 1).trim();
    if (property.startsWith('--')) property = canonicalCustomProperty(property);
    else if (!SAFE_CSS_PROPERTY.test(property)) continue;
    value = value.replace(/var\(\s*(--[a-zA-Z0-9_-]+)/g, (_match, variable: string) => `var(${canonicalCustomProperty(variable)}`);
    if (!value || value.length > 4_000 || /(?:url|image-set|cross-fade|element|expression)\s*\(|javascript:|data:|blob:|@import|[{}<>;"'\\]/i.test(value)) continue;
    if (!/^[#a-zA-Z0-9\s.,()%/+_*:!-]+$/.test(value)) continue;
    value = value.replace(SECRET, '••••');
    SECRET.lastIndex = 0;
    declarations.push(`${property}:${value}`);
    if (declarations.length >= 500) break;
  }
  return declarations.join(';');
}

function splitCssDeclarations(input: string): string[] {
  const output: string[] = [];
  let start = 0;
  let parentheses = 0;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (character === '(') parentheses += 1;
    else if (character === ')') parentheses = Math.max(0, parentheses - 1);
    else if (character === ';' && parentheses === 0) {
      output.push(input.slice(start, index));
      start = index + 1;
    }
  }
  output.push(input.slice(start));
  return output;
}

function findCssBrace(input: string, start: number, target: '{' | '}'): number {
  for (let index = start; index < input.length; index += 1) if (input[index] === target) return index;
  return -1;
}

function matchingCssBrace(input: string, open: number): number {
  let depth = 0;
  for (let index = open; index < input.length; index += 1) {
    if (input[index] === '{') depth += 1;
    else if (input[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
