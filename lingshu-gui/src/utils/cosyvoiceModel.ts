/** Match cloned CosyVoice IDs like cosyvoice-v3.5-flash-bailian-… */
const CLONED_COSYVOICE_MODEL = /^(cosyvoice-v[\d.]+-(?:flash|plus))(?:-|$)/;

/** Infer model from cloned voice ID; keep configured model for system voices (long*). */
export function inferCosyvoiceModelFromVoice(voice: string, configuredModel = ''): string {
  const trimmedVoice = voice.trim();
  const match = trimmedVoice.match(CLONED_COSYVOICE_MODEL);
  if (!match) {
    return configuredModel.trim() || 'cosyvoice-v3-flash';
  }
  return match[1];
}

export function isClonedCosyvoiceVoice(voice: string): boolean {
  return CLONED_COSYVOICE_MODEL.test(voice.trim());
}
