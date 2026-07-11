import { Headset, type LucideIcon } from "lucide-react";

export interface Tool {
  id: string;
  name: string;
  blurb: string; // one line, shown in the workspace header area
  verb: string; // run-button label
  icon: LucideIcon;
  instruction: string; // system-ish line prepended to the user input
  usesTools: boolean; // allow Claude to read the page (get_page / query_dom)
  inputPlaceholder: string;
}

// Single-purpose assistant: read the open Featurebase ticket and draft a reply.
export const TOOL: Tool = {
  id: "cs",
  name: "Featurebase reply",
  blurb: "Read the open ticket → draft a reply",
  verb: "Draft reply",
  icon: Headset,
  instruction:
    "You are a customer-support agent working inside the Featurebase inbox. Use the get_page tool to read the conversation open in the current browser tab. Identify the customer's latest message and their underlying issue, then draft a concise, warm, professional reply in the customer's own language. Do not invent facts — if you'd need information you don't have, say briefly what to check. Output only the reply text, ready to paste.",
  usesTools: true,
  inputPlaceholder: "Optional: extra guidance (tone, facts to include)…",
};
