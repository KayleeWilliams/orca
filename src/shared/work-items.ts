// Why: generic over the item shape because main-process callers emit items
// without repoId (stamped by the renderer after IPC), while renderer callers
// carry the full GitHubWorkItem. Both share only the updatedAt field needed
// here.
export function sortWorkItemsByUpdatedAt<T extends { updatedAt: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  })
}
