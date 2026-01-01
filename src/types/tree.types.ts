export interface TreeConfig {
  idField?: string;
  parentIdField?: string;
  childrenField?: string;
}

export interface TreePaginationOptions {
  page?: number;
  limit?: number;
  sort?: string;

  loadContextOnSearch?: boolean;
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
