export class StepMessagePersister<T extends { role: string } = { role: string }> {
  private persistedResponseCount = 0;

  constructor(private readonly persist: (messages: readonly T[]) => void) {}

  persistNewMessages(responseMessages: readonly T[]): void {
    const fresh = responseMessages.slice(this.persistedResponseCount);
    if (fresh.length === 0) {
      return;
    }
    this.persist(fresh);
    this.persistedResponseCount = responseMessages.length;
  }
}
