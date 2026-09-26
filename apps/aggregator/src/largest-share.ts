/**
 * Of `held` — `[id, holder]` pairs, oldest first — the oldest id of the
 * holder with the most, or undefined when `held` is empty. Ties go to the
 * holder that reached the top count first. `undefined` (no usable client
 * address) is one holder like any other, so requests that all look alike
 * give way to each other oldest first.
 *
 * A full table uses it to pick what gives way: a flood from any number of
 * clients displaces its own entries long before a lone one of anyone else's.
 */
export function oldestOfLargestShare(
  held: Iterable<readonly [string, string | undefined]>,
): string | undefined {
  const shares = new Map<string | undefined, Share>();
  let largest: Share | undefined;
  for (const [id, holder] of held) {
    const share = shares.get(holder) ?? { oldest: id, count: 0 };
    share.count += 1;
    shares.set(holder, share);
    if (largest === undefined || share.count > largest.count) largest = share;
  }
  return largest?.oldest;
}

interface Share {
  oldest: string;
  count: number;
}
