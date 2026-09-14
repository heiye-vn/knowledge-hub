import { describe, expect, it } from 'vitest';
import { nextSnowflakeId } from './snowflake-id.js';

describe('nextSnowflakeId', () => {
  it('should generate a snowflake id string', () => {
    const id = nextSnowflakeId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('should generate unique ids', () => {
    const id1 = nextSnowflakeId();
    const id2 = nextSnowflakeId();
    expect(id1).not.toBe(id2);
  });
});
