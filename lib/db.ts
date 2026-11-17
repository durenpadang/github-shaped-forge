// The forge's database: one process's whole world. The scenario the suite drives is fixed in its seed,
// so the repositories it pages through at boot are the scenario's own: its viewer owns thirty of them.

import { readFileSync } from 'node:fs';
import { makeRepo, putObject, type RepoRecord } from './store.ts';

interface SeedUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

interface SeedRepo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly description: string;
  readonly private: boolean;
  readonly defaultBranch: string;
}

interface Scenario {
  readonly viewer: SeedUser;
  readonly teammate: SeedUser;
  readonly stranger: SeedUser;
  readonly org: string;
  readonly labels: string[];
  readonly branches: string[];
  readonly repos: SeedRepo[];
  readonly orgRepos: SeedRepo[];
  readonly strangerRepos: SeedRepo[];
}

const scenario: Scenario = JSON.parse(readFileSync(new URL('./scenario.json', import.meta.url), 'utf8')) as Scenario;

/** The epoch every generated timestamp counts from: fixed, so two runs agree. */
export const BASE_EPOCH = 1_760_000_000;

/** The login the suite's token names. */
export const VIEWER = scenario.viewer.login;

export class Forge {
  readonly repos = new Map<string, RepoRecord>();
  private nextRepoId = 9000;
  private nextObjectTime = BASE_EPOCH;

  constructor() {
    for (const seed of scenario.repos) this.insert(seed, scenario.labels);
    for (const seed of scenario.orgRepos) this.insert(seed, scenario.labels);
    for (const seed of scenario.strangerRepos) this.insert(seed, scenario.labels);
  }

  private insert(seed: SeedRepo, labels: readonly string[]): void {
    const repo = makeRepo(seed.id, seed.owner, seed.name, seed.description, seed.private, BASE_EPOCH);
    repo.defaultBranch = seed.defaultBranch;
    repo.labels = [...labels];
    this.repos.set(this.key(seed.owner, seed.name), repo);
  }

  /** The map key of one repository. */
  key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  /** A repository by owner and name, whatever the case. */
  repo(owner: string, name: string): RepoRecord | null {
    return this.repos.get(this.key(owner, name)) ?? null;
  }

  /** A fresh repository id. */
  freshRepoId(): number {
    this.nextRepoId += 1;
    return this.nextRepoId;
  }

  /** A deterministic "now": the suite's checks compare shapes, never wall-clock order alone. */
  now(): number {
    return this.nextObjectTime;
  }

  /** Move the clock on one step, so generated timestamps differ. */
  tick(): number {
    this.nextObjectTime += 1;
    return this.nextObjectTime;
  }

  /** Create a repository and answer it. */
  createRepo(owner: string, name: string, description: string, isPrivate: boolean): RepoRecord {
    const repo = makeRepo(this.freshRepoId(), owner, name, description, isPrivate, this.tick());
    repo.labels = [...scenario.labels];
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  /** Every repository one login owns, by id. */
  owned(owner: string): RepoRecord[] {
    const out: RepoRecord[] = [];
    for (const repo of this.repos.values()) if (repo.owner.toLowerCase() === owner.toLowerCase()) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }
}

/** The process's one forge. */
export const forge = new Forge();

/** Write one blob and answer its id. */
export function writeBlob(repo: RepoRecord, content: Buffer): string {
  return putObject(repo, 'blob', content);
}

export { scenario };