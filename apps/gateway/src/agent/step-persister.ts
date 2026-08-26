export class StepMessagePersister<T extends { role: string } = { role: string }> {
  private persistedResponseCount = 0;

  constructor(private readonly persist: (message: T) => void) {}

  persistNewMessages(responseMessages: readonly T[]): void {
    for (const message of responseMessages.slice(this.persistedResponseCount)) {
      this.persist(message);
    }
    this.persistedResponseCount = responseMessages.length;
  }
}
