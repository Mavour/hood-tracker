import { rateLimit } from "./cache/redis";

export async function checkTrackRateLimit(ip: string): Promise<{
  allowed: boolean;
  remaining: number;
}> {
  const max = Number(process.env.RATE_LIMIT_TRACK_PER_HOUR ?? 20);
  return rateLimit(`track:${ip}`, max, 3600);
}

export async function checkNftLookupRateLimit(ip: string): Promise<{
  allowed: boolean;
  remaining: number;
}> {
  const max = Number(process.env.RATE_LIMIT_NFT_PER_HOUR ?? 60);
  return rateLimit(`nft:${ip}`, max, 3600);
}
