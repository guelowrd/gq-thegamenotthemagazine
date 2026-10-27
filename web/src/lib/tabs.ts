// The four sections of the arcade masthead, and the admin's sale desk (the admin's wallet alone, plain English).
export type Tab = "1p" | "vs" | "hub" | "boards" | "admin";
export const TAB_LABEL: Record<Exclude<Tab, "admin">, string> = { "1p": "1P World Tour", vs: "Champion vs Rival", hub: "Player Hub", boards: "Leaderboards" };
