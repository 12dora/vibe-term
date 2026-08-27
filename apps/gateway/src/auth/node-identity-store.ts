import { eq } from 'drizzle-orm';
import { decryptWithContext, encrypt } from '../crypto';
import { nodeIdentity } from '../db/schema';
import { toBuffer, toBytes } from './binary';
import type { AuthDb } from './types';

const IDENTITY_ROW_ID = 1;

export interface NodeIdentityRecord {
  nodeId: string;
  hubUrl: string | null;
  edPrivateKey: Uint8Array;
  x25519PrivateKey: Uint8Array;
  certificateJson: string;
  certSig: Uint8Array;
}

export interface SaveNodeIdentityInput {
  nodeId: string;
  hubUrl: string | null;
  edPrivateKey: Uint8Array;
  x25519PrivateKey: Uint8Array;
  certificateJson: string;
  certSig: Uint8Array;
}

export class NodeIdentityStore {
  constructor(private readonly db: AuthDb) {}

  async load(): Promise<NodeIdentityRecord | null> {
    const row = this.db
      .select()
      .from(nodeIdentity)
      .where(eq(nodeIdentity.id, IDENTITY_ROW_ID))
      .get();
    if (!row) {
      return null;
    }
    const [edPrivateKey, x25519PrivateKey] = await Promise.all([
      decryptKey(row.privateKey, 'private_key', row.nodeId),
      decryptKey(row.x25519PrivateKey, 'x25519_private_key', row.nodeId),
    ]);
    return {
      nodeId: row.nodeId,
      hubUrl: row.hubUrl,
      edPrivateKey,
      x25519PrivateKey,
      certificateJson: row.certificateJson,
      certSig: toBytes(row.certSig),
    };
  }

  async save(input: SaveNodeIdentityInput): Promise<void> {
    const [privateKey, x25519PrivateKey] = await Promise.all([
      encryptKey(input.edPrivateKey),
      encryptKey(input.x25519PrivateKey),
    ]);
    this.db
      .insert(nodeIdentity)
      .values({
        id: IDENTITY_ROW_ID,
        nodeId: input.nodeId,
        hubUrl: input.hubUrl,
        privateKey,
        x25519PrivateKey,
        certificateJson: input.certificateJson,
        certSig: toBuffer(input.certSig),
      })
      .onConflictDoUpdate({
        target: nodeIdentity.id,
        set: {
          nodeId: input.nodeId,
          hubUrl: input.hubUrl,
          privateKey,
          x25519PrivateKey,
          certificateJson: input.certificateJson,
          certSig: toBuffer(input.certSig),
        },
      })
      .run();
  }

  clear(): void {
    this.db.delete(nodeIdentity).where(eq(nodeIdentity.id, IDENTITY_ROW_ID)).run();
  }
}

async function encryptKey(bytes: Uint8Array): Promise<string> {
  return encrypt(toBuffer(bytes).toString('base64'));
}

async function decryptKey(
  ciphertext: string,
  field: 'private_key' | 'x25519_private_key',
  nodeId: string
): Promise<Uint8Array> {
  const encoded = await decryptWithContext(ciphertext, {
    scope: 'node_identity',
    entityId: nodeId,
    field,
  });
  return Uint8Array.from(Buffer.from(encoded, 'base64'));
}
