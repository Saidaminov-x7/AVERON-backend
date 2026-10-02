import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

export const dummyPasswordHash = argon2.hash(randomBytes(32).toString('hex'));
