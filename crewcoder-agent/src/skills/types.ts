export interface Skill {
  id: string;
  description: string;
  triggers: string[];
  matches(prompt: string): boolean;
}

export function createSkill(id: string, description: string, triggers: string[]): Skill {
  return {
    id,
    description,
    triggers,
    matches(prompt: string): boolean {
      const lower = prompt.toLowerCase();
      return triggers.some((trigger) => lower.includes(trigger.toLowerCase()));
    }
  };
}
