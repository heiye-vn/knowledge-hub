import { describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { DocumentImportService } from './document-import.service.js';
import { DocumentImportEntity } from './entities/document-import.entity.js';
import type { AuthUser } from '../auth/auth-user.interface.js';

const actor = { userId: '42', teamIds: [], roles: [] } as unknown as AuthUser;

function updateChain(affected: number | undefined) {
  const chain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    andWhere: vi.fn().mockReturnThis(),
    execute: vi.fn().mockResolvedValue({ affected }),
  };
  return { chain, update: vi.fn().mockReturnValue(chain) };
}

function createService(affected: number | undefined, row: unknown = null) {
  const { chain, update } = updateChain(affected);
  const em = {
    find: vi.fn().mockResolvedValue([]),
    findOneBy: vi.fn().mockResolvedValue(row),
    createQueryBuilder: vi.fn().mockReturnValue({ update }),
  };
  const service = new DocumentImportService(
    em as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, em, chain, update };
}

describe('document import record dismissal', () => {
  it('hides only unfinished-active-free records of the owner', async () => {
    const { service, chain } = createService(1);
    await expect(service.dismiss('1001', actor)).resolves.toEqual({
      dismissed: 1,
    });
    expect(chain.set).toHaveBeenCalledWith(
      expect.objectContaining({ dismissed: true }),
    );
    expect(chain.andWhere).toHaveBeenCalledWith(
      "state IN ('completed', 'failed')",
    );
    expect(chain.where).toHaveBeenCalledWith(
      'id = :id AND owner_id = :ownerId',
      { id: '1001', ownerId: '42' },
    );
  });

  it('rejects dismissing an active task', async () => {
    const { service } = createService(0, { id: '1001', state: 'processing' });
    await expect(service.dismiss('1001', actor)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('returns not-found for a task outside the owner scope', async () => {
    const { service } = createService(0, null);
    await expect(service.dismiss('9999', actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('dismisses all finished records and reports the affected count', async () => {
    const { service, chain } = createService(7);
    await expect(service.dismissFinished(actor)).resolves.toEqual({
      dismissed: 7,
    });
    expect(chain.where).toHaveBeenCalledWith(
      'owner_id = :ownerId AND dismissed = false',
      { ownerId: '42' },
    );
  });

  it('lists only visible records', async () => {
    const { service, em } = createService(0);
    await service.list(actor);
    expect(em.find).toHaveBeenCalledWith(
      DocumentImportEntity,
      expect.objectContaining({
        where: { ownerId: '42', dismissed: false },
        take: 20,
      }),
    );
  });
});
