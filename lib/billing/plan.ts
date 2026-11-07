export const EDITOR_PLAN = {
  name: 'Revline Editor Pro',
  monthlyPrice: 39,
  currency: 'USD',
  trialDays: 3,
  storageGb: 50,
} as const;

/** Pro's headline features, shared by the landing pricing card and the in-app paywall. */
export const PRO_FEATURES = [
  'Edit by prompting: cuts, captions and effects',
  'Motion design, animated subtitles and effects',
  'Edit from Claude, Codex or Cursor with MCP',
  'Unlimited MCP calls',
  '1080p export in any format, no watermark',
  `Unlimited projects, ${EDITOR_PLAN.storageGb} GB storage`,
] as const;

/** Revline MCP: every editing tool from an external agent, plus the web editor for manual edits.
 *  Editing by prompting inside the app stays on Pro. Stripe price: STRIPE_MCP_PRICE_ID. */
export const MCP_PLAN = {
  name: 'Revline MCP',
  monthlyPrice: 19,
  currency: 'USD',
  trialDays: EDITOR_PLAN.trialDays,
  storageGb: 20,
} as const;

export const MCP_FEATURES = [
  'Unlimited MCP calls from Claude, ChatGPT, Codex or Cursor',
  'Every editing tool: cuts, captions, motion films, effects, audio, color and clipping',
  'Web editor to watch and make manual edits',
  '1080p export, no watermark',
  `Unlimited projects, ${MCP_PLAN.storageGb} GB storage`,
] as const;

/** What only Pro has, shown where an MCP member meets an upgrade prompt. */
export const PRO_OVER_MCP = [
  'Edit by prompting inside Revline',
  `${EDITOR_PLAN.storageGb} GB storage`,
] as const;

/** Ultra is paused: Pro includes MCP. Its code and Stripe price stay for a later relaunch. */
export const ULTRA_OFFERED = false;

export const ULTRA_PLAN = {
  name: 'Revline Ultra',
  monthlyPrice: 199,
  currency: 'USD',
} as const;

/** What Ultra adds on top of Pro, shown on the landing page and in the app. */
export const ULTRA_FEATURES = [
  'Frontier models',
  'Fast mode',
  'Pick the model for every edit',
  '4K render',
  'Faster, parallel exports',
  '500 GB storage',
] as const;

/** Fair-use allowances on per-run paid work, per account per UTC calendar month, on every plan.
 *  "Unlimited" covers the tool calls themselves; these bound the provider runs behind a few of them.
 *  `null` means no cap: exportRenderMinutes is metered at export start and capped once a number is set here. */
export const FAIR_USE_MONTHLY = {
  samVideoSegments: 300,
  imageGenerations: 100,
  soundGenerations: 200,
  upscales: 30,
  exportRenderMinutes: null,
} as const satisfies Record<string, number | null>;

export type FairUseKind = keyof typeof FAIR_USE_MONTHLY;

export const FAIR_USE_LABELS: Record<FairUseKind, string> = {
  samVideoSegments: 'video subject cut-outs',
  imageGenerations: 'generated images',
  soundGenerations: 'generated sound effects',
  upscales: 'upscales',
  exportRenderMinutes: 'export minutes',
};
