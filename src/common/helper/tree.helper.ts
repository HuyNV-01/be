/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-return */

import { ObjectLiteral, SelectQueryBuilder, Repository } from 'typeorm';
import { AdvancedQueryHelper } from './query.helper';

// --- Interfaces ---

export interface TreePaginationOptions {
  page?: number | string;
  limit?: number | string;
  sort?: string;
  loadContextOnSearch?: boolean;
}

export interface TreeConfig<T> {
  idField?: keyof T;
  parentIdField?: keyof T;
  childrenField?: string;
  maxDepth?: number;
}

export interface TreeResult<T> {
  data: T[];
  meta: {
    totalRoots: number;
    allNodes: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

/**
 * AdvancedTreeHelper: Chuyên xử lý mô hình Adjacency List (Parent-Child)
 */
export class AdvancedTreeHelper<T extends ObjectLiteral> {
  private idField: string;
  private parentIdField: string;
  private childrenField: string;
  private maxDepth: number;

  private constructor(
    private qb: SelectQueryBuilder<T>,
    config: TreeConfig<T> = {},
  ) {
    this.idField = String(config.idField || 'id');
    this.parentIdField = String(config.parentIdField || 'parentId');
    this.childrenField = config.childrenField || 'children';
    this.maxDepth = config.maxDepth || 10;
  }

  static from<T extends ObjectLiteral>(
    source: Repository<T> | SelectQueryBuilder<T>,
    alias: string,
    config?: TreeConfig<T>,
  ): AdvancedTreeHelper<T> {
    const builder =
      source instanceof Repository ? source.createQueryBuilder(alias) : source;
    return new AdvancedTreeHelper(builder, config);
  }

  async getPaginatedTree(
    options: TreePaginationOptions,
  ): Promise<TreeResult<T>> {
    const hasConditions = this.qb.expressionMap.wheres.length > 0;

    if (hasConditions) {
      return this.handleSearchMode(options);
    } else {
      return this.handleBrowseMode(options);
    }
  }

  // ==========================================
  // MODE 1: BROWSE
  // ==========================================
  private async handleBrowseMode(
    options: TreePaginationOptions,
  ): Promise<TreeResult<T>> {
    const rootQb = this.qb.clone();

    rootQb.andWhere(`${rootQb.alias}.${this.parentIdField} IS NULL`);

    // FIX: Sử dụng AdvancedQueryHelper để phân trang
    const paginationHelper = AdvancedQueryHelper.from(rootQb, rootQb.alias);

    // Sort logic
    if (options.sort) {
      options.sort.split(',').forEach((s) => {
        const [f, o] = s.split(':');
        const col = f.includes('.') ? f : `${rootQb.alias}.${f}`;
        rootQb.addOrderBy(col, o?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC');
      });
    }

    const rootResult = await paginationHelper.getPaginated({
      page: options.page,
      limit: options.limit,
    });

    if (rootResult.data.length === 0) {
      return this.emptyResult(options);
    }

    const rootIds = rootResult.data.map((node) => node[this.idField]);

    const descendants = await this.fetchDescendants(rootIds);

    // Merge root + descendants
    const allNodes = [...rootResult.data, ...descendants];

    const tree = AdvancedTreeHelper.buildTreeStructure(allNodes, {
      idField: this.idField as keyof T,
      parentIdField: this.parentIdField as keyof T,
      childrenField: this.childrenField,
    });

    return {
      data: tree,
      meta: {
        totalRoots: rootResult.meta.total,
        allNodes: allNodes.length,
        page: rootResult.meta.page,
        limit: rootResult.meta.limit,
        totalPages: rootResult.meta.totalPages,
      },
    };
  }

  // ==========================================
  // MODE 2: SEARCH
  // ==========================================
  private async handleSearchMode(
    options: TreePaginationOptions,
  ): Promise<TreeResult<T>> {
    const matchedNodes = await this.qb.getMany();

    if (matchedNodes.length === 0) {
      return this.emptyResult(options);
    }

    let finalNodes = matchedNodes;

    if (options.loadContextOnSearch) {
      const matchedIds = matchedNodes.map((n) => n[this.idField]);

      const [ancestors, descendants] = await Promise.all([
        this.fetchAncestors(matchedIds),
        this.fetchDescendants(matchedIds),
      ]);

      const nodeMap = new Map<string | number, T>();
      [...matchedNodes, ...ancestors, ...descendants].forEach((n) => {
        nodeMap.set(n[this.idField], n);
      });

      finalNodes = Array.from(nodeMap.values());
    }

    const tree = AdvancedTreeHelper.buildTreeStructure(finalNodes, {
      idField: this.idField as keyof T,
      parentIdField: this.parentIdField as keyof T,
      childrenField: this.childrenField,
    });

    return {
      data: tree,
      meta: {
        totalRoots: tree.length,
        allNodes: finalNodes.length,
        page: 1,
        limit: finalNodes.length,
        totalPages: 1,
      },
    };
  }

  // ==========================================
  // CORE LOGIC
  // ==========================================

  private async fetchDescendants(rootIds: any[]): Promise<T[]> {
    let allDescendants: T[] = [];
    let currentLevelIds = [...rootIds];
    let depth = 0;

    while (currentLevelIds.length > 0 && depth < this.maxDepth) {
      const qb = this.qb.clone();
      qb.expressionMap.wheres = [];

      qb.where(`${qb.alias}.${this.parentIdField} IN (:...ids)`, {
        ids: currentLevelIds,
      });

      const children = await qb.getMany();

      if (children.length === 0) break;

      allDescendants = [...allDescendants, ...children];
      currentLevelIds = children.map((c) => c[this.idField]);
      depth++;
    }

    return allDescendants;
  }

  private async fetchAncestors(nodeIds: any[]): Promise<T[]> {
    let allAncestors: T[] = [];
    let currentIds = [...nodeIds];

    // FIX: Lấy Repository từ Connection để đảm bảo đúng Entity Target
    const entityTarget = this.qb.expressionMap.mainAlias?.target;
    if (!entityTarget) throw new Error('Cannot determine entity target');

    const repository = this.qb.connection.getRepository(entityTarget);

    while (currentIds.length > 0) {
      // FIX: Ép kiểu any cho getMany() ở bước trung gian này để tránh lỗi type T
      const nodes = await repository
        .createQueryBuilder('e')
        .select([`e.${this.parentIdField}`, `e.${this.idField}`])
        .where(`e.${this.idField} IN (:...ids)`, { ids: currentIds })
        .getMany();

      const parentIds = nodes
        .map((n: any) => n[this.parentIdField])
        .filter((id: any) => id !== null && id !== undefined);

      if (parentIds.length === 0) break;

      // Fetch full parents
      // FIX: Ép kiểu kết quả về T[]
      const parents = (await repository
        .createQueryBuilder('e')
        .where(`e.${this.idField} IN (:...pIds)`, { pIds: parentIds })
        .getMany()) as T[];

      allAncestors = [...allAncestors, ...parents];
      currentIds = parents.map((p) => p[this.idField]);
    }

    return allAncestors;
  }

  // ==========================================
  // UTILS
  // ==========================================

  /**
   * FIX: Ép kiểu trả về là T[] thay vì để tự suy luận
   */
  static buildTreeStructure<T extends ObjectLiteral>(
    flatList: T[],
    config: TreeConfig<T>,
  ): T[] {
    const idField = String(config.idField || 'id');
    const parentField = String(config.parentIdField || 'parentId');
    const childrenField = config.childrenField || 'children';

    const rootNodes: T[] = [];
    const map = new Map<string | number, T>();

    flatList.forEach((node) => {
      // FIX: Type Casting cho object mới
      const nodeWithChildren = { ...node, [childrenField]: [] } as T;
      map.set(node[idField], nodeWithChildren);
    });

    flatList.forEach((node) => {
      const currentNode = map.get(node[idField]);
      const parentId = node[parentField];
      const hasParent = parentId !== null && parentId !== undefined;

      if (hasParent && map.has(parentId)) {
        const parentNode = map.get(parentId);
        if (parentNode) {
          // FIX: Access dynamic property an toàn
          (parentNode as any)[childrenField].push(currentNode);
        }
      } else {
        if (currentNode) {
          rootNodes.push(currentNode);
        }
      }
    });

    return rootNodes;
  }

  private emptyResult(options: TreePaginationOptions): TreeResult<T> {
    return {
      data: [],
      meta: {
        totalRoots: 0,
        allNodes: 0,
        page: Number(options.page) || 1,
        limit: Number(options.limit) || 10,
        totalPages: 0,
      },
    };
  }
}
