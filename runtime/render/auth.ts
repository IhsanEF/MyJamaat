import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { verifiedUser, safeReturnTo } from "./sessions.mjs";
export type ChatGPTUser = { userId: string; email: string; displayName: string; fullName: string | null };
export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const requestHeaders = await headers();
  return verifiedUser(requestHeaders.get("cookie"));
}
export async function requireChatGPTUser(returnTo: string): Promise<ChatGPTUser> {
  const user = await getChatGPTUser();
  if (user) return user;
  redirect(chatGPTSignInPath(returnTo));
}
export function chatGPTSignInPath(returnTo = "/") { return `/signin?return_to=${encodeURIComponent(safeReturnTo(returnTo))}`; }
export function chatGPTSignOutPath(returnTo = "/") { return `/signout?return_to=${encodeURIComponent(safeReturnTo(returnTo))}`; }
