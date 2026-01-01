/* eslint-disable @typescript-eslint/no-unsafe-function-type */
/* eslint-disable @typescript-eslint/no-unused-vars */

export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'like'
  | 'ilike'
  | 'in'
  | 'notIn'
  | 'between'
  | 'isNull'
  | 'isNotNull';

export interface FilterRule {
  column: string;
  operator?: FilterOperator;
  value?: any;
}

export interface PaginationOptions {
  page?: number;
  limit?: number;
  sort?: string;
  filter?: string;
}

export interface JsonRelationConfig<T = any> {
  resultAlias: string;
  targetEntity: Function | string;
  targetAlias: string;

  outerLink: {
    innerField: string;
    outerField: string;
    operator?: FilterOperator;
  };

  innerJoins?: {
    entity: Function | string;
    alias: string;
    condition: string;
    type?: 'inner' | 'left';
  }[];

  conditions?: FilterRule[];
  selectFields: Record<string, string>;
  relationType?: 'many' | 'one';
}

export interface PaginatedResult<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}
