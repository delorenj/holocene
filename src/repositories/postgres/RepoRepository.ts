/**
 * RepoRepository
 * PostgreSQL repository for Repo domain model
 */

import { Repo, RepoData } from '../../domain/models/Repo';
import { BasePostgresRepository } from './BasePostgresRepository';

export class RepoRepository extends BasePostgresRepository<Repo> {
  constructor() {
    super('repos');
  }

  protected mapToDomain(row: Record<string, unknown>): Repo {
    return new Repo({
      id: row.id as string,
      name: row.name as string,
      remote: row.remote as string,
      localPath: row.local_path as string,
      defaultBranch: row.default_branch as string,
      leadArchitectId: row.lead_architect_id as string | undefined,
      projectManagerId: row.project_manager_id as string | undefined,
      qaLeadId: row.qa_lead_id as string | undefined,
      createdAt: row.created_at ? new Date(row.created_at as string) : undefined,
      updatedAt: row.updated_at ? new Date(row.updated_at as string) : undefined,
    });
  }

  protected mapToDatabase(model: Partial<Repo>): Record<string, unknown> {
    const data: Record<string, unknown> = {};

    if (model.id) data.id = model.id;
    if ('name' in model) data.name = model.name;
    if ('remote' in model) data.remote = model.remote;
    if ('localPath' in model) data.local_path = model.localPath;
    if ('defaultBranch' in model) data.default_branch = model.defaultBranch;

    return data;
  }

  /**
   * Find repos by project ID
   */
  async findByProjectId(projectId: string): Promise<Repo[]> {
    // TODO: Implement join query with project_repos table
    return [];
  }

  /**
   * Find repos by lead architect
   */
  async findByLeadArchitect(architectId: string): Promise<Repo[]> {
    return this.findAll({ leadArchitectId: architectId });
  }
}
