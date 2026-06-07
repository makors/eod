export function botText(input: string | string[]): string {
  const lines = Array.isArray(input) ? input : input.split("\n");

  return lines
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean)
    .map(stripTrailingPunctuation)
    .join("\n");
}

function stripTrailingPunctuation(line: string): string {
  return line.replace(/[.!?。！？]+$/u, "");
}

export const messages = {
  registered: () =>
    botText([
      "ok im awake",
      "text test poke",
      "we prove the timer works first",
    ]),
  started: () =>
    botText([
      "started",
      "i know this chat now",
      "small terrifying infrastructure win",
    ]),
  stopped: () =>
    botText([
      "stopped",
      "i will not poke this chat",
      "for now",
    ]),
  unknown: () =>
    botText([
      "logged",
      "not a command yet",
      "tiny steps captain",
    ]),
  attachmentLogged: () =>
    botText([
      "got the photo",
      "logged it",
      "evidence goblet acquired",
    ]),
  testPokeScheduled: (seconds: number) =>
    botText([
      `test poke scheduled for ${seconds} seconds`,
      "do not flee",
      "i have a calendar now",
    ]),
  testPokeBody: () =>
    botText([
      "poke",
      "timer works",
      "very annoying",
      "very promising",
    ]),
  status: (parts: {
    enabled: boolean;
    inboundCount: number;
    attachmentCount: number;
    nextJobDueAt?: string;
  }) =>
    botText([
      parts.enabled ? "enabled" : "disabled",
      `${parts.inboundCount} inbound logged`,
      `${parts.attachmentCount} attachments logged`,
      parts.nextJobDueAt ? `next poke ${parts.nextJobDueAt}` : "no pending pokes",
    ]),
};
