/** Shared intent and evidence rules for volatile facts and follow-up questions. */
export interface LiveEvidence {
  kind: 'live' | 'internal' | 'static';
  fetchedAt?: number;
  sources?: string[];
}

const CURRENT_MARKERS =
  /\b(?:today|yesterday|tonight|last night|right now|currently|current|latest|most recent|this season|season to date|so far this season|current season|as of now|this year|this week|this month|live score|live scores|up to date|at present|nowadays|this quarter|this fiscal year|recently|breaking|price|exchange rate|stock quote|crypto price|weather|forecast|score|scores|match result|game result|lineup|starting eleven|standings|table position|transfer fee)\b|\b(?:hoy|ayer|actualmente|actual|últim[oa]s?|esta temporada|este año|ahora mismo|últim[oa]s? datos|en vivo|aujourd'hui|actuellement|dernier(?:e|s|es)?|cette saison|cette année|maintenant|heute|aktuell|neueste|diese saison|dieses jahr|oggi|attualmente|último|atualmente|esta época|agora|сейчас|последн(?:ий|яя|ее)|текущ(?:ий|ая|ее))\b/i;

const CURRENT_QUANTITY =
  /\b(?:how many|number of|total|current stats?|latest stats?)\b.{0,80}\b(?:goals?|points?|wins?|losses?|assists?|appearances?|scores?|matches|games|titles|records|followers|subscribers|employees|posts|views|votes|cases|deaths|population|revenue|profit|price|value)\b|\b(?:goals?|points?|assists?|appearances?)\s+(?:has|have|did)\s+[\w'-]+\s+(?:score|scored|make|made)\b|\b(?:how much is|price of|value of)\b.{0,60}\b(?:bitcoin|btc|ethereum|eth|solana|sol|stock|share|dollar|euro|naira|gold|oil)\b/i;

const CURRENT_ROLE_OR_VALUE =
  /\b(?:who is|who's|what is)\s+(?:the\s+)?(?:current\s+)?(?:president|prime minister|ceo|head coach|manager|leader|governor|mayor|richest person)\s+(?:of|in)\b|\b(?:price|exchange rate|stock price|market cap|weather|temperature)\s+(?:of|in|for)\b|\bwhere does\s+[\w'-]+\s+play\b|\bwhat (?:team|club) does\s+[\w'-]+\s+play for\b/i;

export function requiresCurrentWebEvidence(text: string): boolean {
  const normalized = (text || '').trim();
  return CURRENT_MARKERS.test(normalized) || CURRENT_QUANTITY.test(normalized) || CURRENT_ROLE_OR_VALUE.test(normalized);
}

const CURRENT_FOLLOW_UP =
  /^(?:and\s+)?(?:what about|how about|what of|also|he|she|they|it|that|those|them|him|his|her|their|its|there|how many|did he|did she|did they|has he|has she|have they|what's his|what is his|same for)\b|\b(?:this one|that one|the other one)\b/i;
const SHORT_ACKNOWLEDGEMENT = /^(?:and\s+)?(?:yes|yeah|yep|no|nope|ok|okay|thanks|thank you|great|cool|fine|right|lol|haha|hello|hi|bye|what|who|why|how|where|when|which|also|then)\b/i;

/**
 * Short follow-ups inherit live-data intent from an earlier user question in this chat.
 * Keep the source turn so a search such as “and Ronaldo?” retains its subject and stat.
 */
export function getCurrentEvidenceContext(
  currentMessage: string,
  previousUserMessages: string[]
): { required: boolean; query: string } {
  const current = currentMessage.trim();
  if (requiresCurrentWebEvidence(current)) return { required: true, query: current };

  const shortEntityFollowUp = /^(?:and\s+)?[\p{L}\p{M}'’-]+(?:\s+[\p{L}\p{M}'’-]+)?\??$/iu.test(current);
  if (!CURRENT_FOLLOW_UP.test(current) && !(shortEntityFollowUp && !SHORT_ACKNOWLEDGEMENT.test(current))) {
    return { required: false, query: current };
  }
  const sourceTurn = [...previousUserMessages].reverse().find((message) => requiresCurrentWebEvidence(message));
  if (!sourceTurn) return { required: false, query: current };

  return {
    required: true,
    query: `${sourceTurn.trim().slice(0, 300)} Follow-up: ${current.slice(0, 180)}`,
  };
}

export function hasFreshLiveEvidence(evidence: LiveEvidence | undefined, now = Date.now()): boolean {
  if (!evidence || evidence.kind !== 'live') return false;
  if (typeof evidence.fetchedAt !== 'number' || !Number.isFinite(evidence.fetchedAt)) return false;
  const age = now - evidence.fetchedAt;
  if (age < 0 || age > 10 * 60 * 1000) return false;
  return Array.isArray(evidence.sources) && evidence.sources.some((source) => {
    try {
      const url = new URL(source);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  });
}

export function isConversationRecallRequest(text: string): boolean {
  return /\b(?:what did (?:we|i|you) (?:talk about|discuss|agree|decide|say|ask)|what was (?:our|the) (?:plan|decision|agreement)|remind me what|do you remember|remember (?:what|when|where|which|that|the)|recall (?:our|the) earlier|earlier (?:i|we|you) (?:said|talked|discussed|asked)|last time (?:we|i|you)|from (?:our|the) earlier conversation|what did i tell you)\b/i.test(
    text || ''
  );
}
