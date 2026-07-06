export const AGENT_INSTRUCTION_MAX_LENGTH = 2000;

export function isAgentInstructionValid(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 && trimmed.length <= AGENT_INSTRUCTION_MAX_LENGTH
  );
}
