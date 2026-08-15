import { ApiError } from '../errors.js';
import { REPLAY_LIMITS, type ReplayTextMode } from './types.js';

const MASK = '••••';
const URL_LIKE = /(?:https?:\/\/|javascript:|data:|blob:|url\s*\()/i;
const RELATIVE_LOCATION_LIKE = /^\s*(?:\/|\.{1,2}\/|\?|#)/;
const LOCATION_KEY = /^(?:url|uri|path|pathname|search|hash|location|baseurl)$/i;
const SECRET_LIKE = /(?:bearer\s+[a-z0-9._~-]+|(?:sk|pk|pt)_[a-f0-9]{12,}|eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}|[A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key)[A-Za-z0-9_-]*\s*[:=]\s*\S+|\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b|\b(?:\d[ -]*?){13,19}\b)/gi;
const STRUCTURAL_TAG = /^[a-z][a-z0-9-]{0,40}$/;
const SAFE_ATTRIBUTE = /^(?:class|id|role|aria-[a-z-]+|title|alt|type|name|placeholder|style|_csstext|disabled|checked|selected|readonly|multiple|tabindex|colspan|rowspan|width|height|contenteditable|data-poolstatis-replay-blocked)$/i;
const NETWORK_ATTRIBUTE = /^(?:src|srcset|href|action|formaction|poster|background|ping|integrity|nonce|crossorigin|referrerpolicy|srcdoc)$/i;
const CANONICAL_STRUCTURAL_TOKEN = /^rr-[0-9a-f]{8}$/i;
const BOOLEAN_ATTRIBUTE = /^(?:disabled|checked|selected|readonly|multiple)$/i;
const NUMERIC_ATTRIBUTE = /^(?:tabindex|colspan|rowspan|width|height)$/i;
const SAFE_ROLE = /^(?:button|link|dialog|main|navigation|banner|contentinfo|region|heading|list|listitem|img|presentation|none|status|alert|tab|tabpanel|textbox|checkbox|radio|menu|menuitem|progressbar|slider|switch|table|row|cell)$/i;
const SAFE_INPUT_TYPE = /^(?:button|submit|reset|text|checkbox|radio|range|number|date|time|search)$/i;
const SAFE_CSS_PROPERTY = /^(?:display|position|top|right|bottom|left|inset(?:-(?:block|inline)(?:-(?:start|end))?)?|z-index|float|clear|overflow(?:-[xy])?|visibility|opacity|box-sizing|width|min-width|max-width|height|min-height|max-height|margin(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|padding(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-(?:width|style|color))?|border-radius|border-collapse|border-spacing|outline(?:-(?:width|style|color|offset))?|flex(?:-(?:basis|direction|flow|grow|shrink|wrap))?|align-(?:content|items|self)|justify-(?:content|items|self)|place-(?:content|items|self)|gap|row-gap|column-gap|grid(?:-(?:auto-columns|auto-flow|auto-rows|column|column-end|column-gap|column-start|gap|row|row-end|row-gap|row-start|template-columns|template-rows))?|order|columns|column-count|column-width|object-fit|object-position|transform|transform-origin|translate|rotate|scale|font-size|font-style|font-weight|font-stretch|line-height|letter-spacing|word-break|word-spacing|overflow-wrap|white-space|text-align|text-decoration(?:-(?:color|line|style|thickness))?|text-transform|text-overflow|text-indent|color|background-color|box-shadow|vertical-align|list-style-position|list-style-type|table-layout|pointer-events|user-select|aspect-ratio|scroll-behavior|scroll-margin(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|scroll-padding(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|overscroll-behavior(?:-[xy])?)$/i;

export interface SanitizedReplayPayload {
  events: Array<Record<string, unknown>>;
  byteSize: number;
  eventCount: number;
  firstTimestamp: number;
  lastTimestamp: number;
  hasCheckout: boolean;
}

interface SanitizeOptions {
  route: string;
  textMode: ReplayTextMode;
  maskSelectors?: string[];
  blockSelectors?: string[];
}

export function sanitizeReplayEvents(input: unknown, options: SanitizeOptions): SanitizedReplayPayload {
  if (!Array.isArray(input) || input.length < 1 || input.length > REPLAY_LIMITS.maxEventsPerChunk) {
    throw new ApiError(400, 'replay_events_invalid', 'replay chunk must contain between 1 and 500 events');
  }
  const seen = new WeakSet<object>();
  let nodes = 0;
  const events = input.map((candidate, index) => {
    if (!isPlainObject(candidate)) throw malformed(index);
    const type = candidate.type;
    const timestamp = candidate.timestamp;
    if (!Number.isInteger(type) || (type as number) < 0 || (type as number) > 4
        || !Number.isSafeInteger(timestamp) || (timestamp as number) < 0) {
      throw malformed(index);
    }
    const event: Record<string, unknown> = { type, timestamp };
    if ('data' in candidate) {
      event.data = sanitizeValue(candidate.data, {
        depth: 0,
        key: 'data',
        textMode: options.textMode,
        route: options.route,
        forceMaskText: false,
        cssText: false,
        cssRule: false,
        maskSelectors: options.maskSelectors ?? [],
        blockSelectors: options.blockSelectors ?? [],
        seen,
        countNode: () => {
          nodes += 1;
          if (nodes > 50_000) throw new ApiError(413, 'replay_payload_too_complex', 'replay chunk has too many nodes');
        },
      });
    }
    return event;
  });
  for (let index = 1; index < events.length; index += 1) {
    if (Number(events[index]!.timestamp) < Number(events[index - 1]!.timestamp)) {
      throw new ApiError(400, 'replay_timestamps_invalid', 'rrweb event timestamps must be nondecreasing inside each chunk');
    }
  }
  const timestamps = events.map((event) => Number(event.timestamp));
  const serialized = JSON.stringify(events);
  const byteSize = Buffer.byteLength(serialized);
  if (byteSize > REPLAY_LIMITS.maxChunkBytes) {
    throw new ApiError(413, 'replay_chunk_too_large', `replay chunk exceeds ${REPLAY_LIMITS.maxChunkBytes} bytes`);
  }
  return {
    events,
    byteSize,
    eventCount: events.length,
    firstTimestamp: Math.min(...timestamps),
    lastTimestamp: Math.max(...timestamps),
    hasCheckout: hasInitialFullSnapshot(events),
  };
}

function hasInitialFullSnapshot(events: Array<Record<string, unknown>>): boolean {
  for (const event of events) {
    if (event.type === 2) return true;
    if (event.type === 3) return false;
  }
  return false;
}

interface WalkContext {
  depth: number;
  key: string;
  textMode: ReplayTextMode;
  route: string;
  forceMaskText: boolean;
  cssText: boolean;
  cssRule: boolean;
  maskSelectors: string[];
  blockSelectors: string[];
  seen: WeakSet<object>;
  countNode: () => void;
}

function sanitizeValue(value: unknown, context: WalkContext): unknown {
  if (context.depth > 40) throw new ApiError(413, 'replay_payload_too_deep', 'replay chunk nesting exceeds 40 levels');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ApiError(400, 'replay_number_invalid', 'replay numbers must be finite');
    return value;
  }
  if (typeof value === 'string') return sanitizeString(value, context);
  if (Array.isArray(value)) {
    if (value.length > 50_000) throw new ApiError(413, 'replay_array_too_large', 'replay array is too large');
    return value.map((item) => sanitizeValue(item, { ...context, depth: context.depth + 1 }));
  }
  if (!isPlainObject(value)) throw new ApiError(400, 'replay_value_invalid', 'replay values must be plain JSON');
  if (context.seen.has(value)) throw new ApiError(400, 'replay_cycle_invalid', 'replay values must not contain cycles');
  context.seen.add(value);
  context.countNode();

  const tagName = typeof value.tagName === 'string' ? value.tagName.toLowerCase() : null;
  const blocked = tagName !== null && isBlockedNode(value, context.blockSelectors);
  const executable = tagName !== null && (blocked || ['script', 'iframe', 'object', 'embed', 'form', 'base', 'meta'].includes(tagName));
  const contentEditableValue = isPlainObject(value.attributes)
    ? attributeValue(value.attributes, 'contenteditable')
    : undefined;
  const contentEditable = contentEditableValue !== undefined
    && contentEditableValue !== false
    && !(typeof contentEditableValue === 'string'
      && contentEditableValue.toLowerCase() === 'false');
  const inputIncremental = value.source === 5;
  const forceMaskText = Boolean(context.forceMaskText
    || tagName === 'input'
    || tagName === 'textarea'
    || contentEditable
    || inputIncremental
    || tagName !== null && isMaskedNode(value, context.maskSelectors));
  const cssText = context.cssText || value.isStyle === true || tagName === 'style';
  const cssRule = context.cssRule || value.source === 8 || value.source === 15;
  const styleDeclaration = value.source === 13;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor' || /^on/i.test(key)) continue;
    if (key === 'tagName') {
      output.tagName = executable ? 'div' : tagName && STRUCTURAL_TAG.test(tagName) ? tagName : 'div';
      continue;
    }
    if (key === 'attributes' && isPlainObject(child)) {
      output.attributes = executable
        ? { 'data-poolstatis-replay-blocked': 'true' }
        : sanitizeAttributes(child, forceMaskText, context.textMode);
      continue;
    }
    if (styleDeclaration && key === 'set' && isPlainObject(child)) {
      const set = sanitizeStyleDeclarationSet(child);
      if (set) output.set = set;
      continue;
    }
    if (styleDeclaration && key === 'remove' && isPlainObject(child)) {
      const remove = sanitizeStyleDeclarationRemove(child);
      if (remove) output.remove = remove;
      continue;
    }
    if (executable && (key === 'childNodes' || key === 'textContent')) {
      output[key] = key === 'childNodes' ? [] : '';
      continue;
    }
    output[key] = sanitizeValue(child, {
      ...context,
      depth: context.depth + 1,
      key,
      forceMaskText,
      cssText,
      cssRule,
    });
  }
  context.seen.delete(value);
  return output;
}

function sanitizeAttributes(
  attributes: Record<string, unknown>,
  forceMask: boolean,
  textMode: ReplayTextMode,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(attributes)) {
    const name = rawName.toLowerCase();
    if (/^on/.test(name) || NETWORK_ATTRIBUTE.test(name) || !SAFE_ATTRIBUTE.test(name)) continue;
    if (typeof rawValue !== 'string' && typeof rawValue !== 'boolean' && typeof rawValue !== 'number') continue;
    let value = String(rawValue).slice(0, 2_000).replace(/url\s*\([^)]*\)/gi, '');
    if (name === 'class' || name === 'id') value = structuralTokens(value);
    else if (name === 'style') value = sanitizeCssDeclarations(value);
    else if (name === '_csstext') value = sanitizeCssStylesheet(value);
    else if (BOOLEAN_ATTRIBUTE.test(name)) {
      if (rawValue !== true && value !== '' && value.toLowerCase() !== name) continue;
      value = '';
    } else if (NUMERIC_ATTRIBUTE.test(name)) {
      if (!/^-?\d{1,6}$/.test(value)) continue;
      const numeric = Number(value);
      if (!Number.isSafeInteger(numeric) || numeric < -1 || numeric > 100_000) continue;
      value = String(numeric);
    } else if (name === 'contenteditable') value = value.toLowerCase() === 'false' ? 'false' : 'true';
    else if (name === 'aria-hidden') value = /^(?:true|false)$/i.test(value) ? value.toLowerCase() : MASK;
    else if (name === 'role' && !SAFE_ROLE.test(value)) value = MASK;
    else if (name === 'type' && !SAFE_INPUT_TYPE.test(value)) value = MASK;
    else if (forceMask
        || name === 'name'
        || name === 'title'
        || name === 'alt'
        || name === 'placeholder'
        || name.startsWith('aria-') && name !== 'aria-hidden') value = MASK;
    else if (SECRET_LIKE.test(value)) value = MASK;
    SECRET_LIKE.lastIndex = 0;
    output[name === '_csstext' ? '_cssText' : name] = value;
  }
  return output;
}

function structuralTokens(value: string): string {
  return value.split(/\s+/).filter(Boolean).slice(0, 20).map(canonicalStructuralToken).join(' ');
}

function sanitizeString(value: string, context: WalkContext): string {
  if (value.length > 100_000) throw new ApiError(413, 'replay_string_too_large', 'replay string exceeds 100000 characters');
  if (context.key === '_cssText' || context.key === 'cssText' || context.key === 'rule'
      || context.cssRule && (context.key === 'replace' || context.key === 'replaceSync')
      || context.cssText && context.key === 'textContent') {
    return sanitizeCssStylesheet(value);
  }
  if (context.key === 'href') return `https://replay.invalid/${context.route}`;
  if (LOCATION_KEY.test(context.key)) return MASK;
  if (context.key === 'tagName') return STRUCTURAL_TAG.test(value.toLowerCase()) ? value.toLowerCase() : 'div';
  if (context.key === 'textContent' || context.key === 'value' || context.key === 'text') {
    if (context.forceMaskText || context.textMode === 'masked') return maskPreservingShape(value);
  }
  if (context.textMode === 'masked') return maskPreservingShape(value);
  if (URL_LIKE.test(value)) return MASK;
  URL_LIKE.lastIndex = 0;
  if (RELATIVE_LOCATION_LIKE.test(value)) return MASK;
  const redacted = value.replace(SECRET_LIKE, MASK);
  SECRET_LIKE.lastIndex = 0;
  return redacted.slice(0, 100_000);
}

function sanitizeStyleDeclarationSet(input: Record<string, unknown>): Record<string, string | null> | null {
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

function sanitizeStyleDeclarationRemove(input: Record<string, unknown>): { property: string } | null {
  if (typeof input.property !== 'string') return null;
  let property = input.property.trim().toLowerCase();
  if (property.startsWith('--')) property = canonicalCustomProperty(property);
  else if (!SAFE_CSS_PROPERTY.test(property)) return null;
  return { property };
}

function isBlockedNode(node: Record<string, unknown>, selectors: string[]): boolean {
  const tagName = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : '';
  const attributes = isPlainObject(node.attributes) ? node.attributes : {};
  const type = typeof attributes.type === 'string' ? attributes.type.toLowerCase() : '';
  const autocomplete = typeof attributes.autocomplete === 'string' ? attributes.autocomplete.toLowerCase() : '';
  return hasAttribute(attributes, 'data-poolstatis-replay-blocked')
    || hasAttribute(attributes, 'data-poolstatis-block')
    || classTokens(attributes).includes('rr-block')
    || tagName === 'input' && (type === 'password' || type === 'hidden'
      || autocomplete.includes('cc-') || autocomplete.includes('password') || autocomplete === 'one-time-code')
    || hasAttribute(attributes, 'data-payment')
    || hasAttribute(attributes, 'data-auth-token')
    || selectors.some((selector) => matchesSimpleSelector(node, selector));
}

function isMaskedNode(node: Record<string, unknown>, selectors: string[]): boolean {
  const tagName = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : '';
  const attributes = isPlainObject(node.attributes) ? node.attributes : {};
  return tagName === 'input'
    || tagName === 'textarea'
    || hasAttribute(attributes, 'data-poolstatis-mask')
    || classTokens(attributes).includes('rr-mask')
    || selectors.some((selector) => matchesSimpleSelector(node, selector));
}

function matchesSimpleSelector(node: Record<string, unknown>, selector: string): boolean {
  const attributes = isPlainObject(node.attributes) ? node.attributes : {};
  const tagName = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : '';
  if (selector.startsWith('.')) return classTokens(attributes).includes(selector.slice(1));
  if (selector.startsWith('#')) return String(attributeValue(attributes, 'id') ?? '') === selector.slice(1);
  const attribute = selector.match(/^\[([a-zA-Z_:][a-zA-Z0-9_.:-]*)(?:="([a-zA-Z0-9_.:-]{1,80})")?\]$/);
  if (attribute) {
    const value = attributeValue(attributes, attribute[1]!);
    return value !== undefined && (attribute[2] === undefined || String(value) === attribute[2]);
  }
  return tagName === selector.toLowerCase();
}

function hasAttribute(attributes: Record<string, unknown>, name: string): boolean {
  return attributeValue(attributes, name) !== undefined;
}

function attributeValue(attributes: Record<string, unknown>, name: string): unknown {
  const entry = Object.entries(attributes).find(([candidate]) => candidate.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

function classTokens(attributes: Record<string, unknown>): string[] {
  const value = attributeValue(attributes, 'class');
  return typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : [];
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
  if (!/^[a-zA-Z0-9@\s():.,/%+_-]+$/.test(input) || URL_LIKE.test(input)) return '';
  URL_LIKE.lastIndex = 0;
  const result = input.replace(SECRET_LIKE, MASK);
  SECRET_LIKE.lastIndex = 0;
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
    value = value.replace(SECRET_LIKE, MASK);
    SECRET_LIKE.lastIndex = 0;
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

function maskPreservingShape(value: string): string {
  return value.replace(/\S/g, '•').slice(0, 100_000);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function malformed(index: number): ApiError {
  return new ApiError(400, 'replay_event_invalid', `replay event ${index} has an invalid rrweb envelope`);
}
