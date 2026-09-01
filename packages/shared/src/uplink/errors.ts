export const HUB_NOT_WRITER = 'HUB_NOT_WRITER' as const;

export type HubNotWriterError = {
  code: typeof HUB_NOT_WRITER;
  writerHubId: string | null;
  writerPublicUrl: string | null;
  writerEpoch: number | null;
};
