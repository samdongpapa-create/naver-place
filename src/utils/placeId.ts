export function extractPlaceId(input: string): string | null {
  // input이 placeId 자체일 수도 / URL일 수도
  const trimmed = (input ?? "").trim();
  if (!trimmed) return null;

  if (/^\d{5,}$/.test(trimmed)) return trimmed;

  // .../place/1443688242 or .../hairshop/1443688242/home
  const m = trimmed.match(/\/(?:place|hairshop|restaurant|cafe|accommodation|hospital|pharmacy|beauty|bakery)\/(\d{5,})/);
  if (m?.[1]) return m[1];

  const m2 = trimmed.match(/\/place\/(\d{5,})/);
  if (m2?.[1]) return m2[1];

  return null;
}
