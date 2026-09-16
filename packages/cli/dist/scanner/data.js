import { apiOrigin } from '@mnemonik/shared';
export async function deleteScannerIndex(projectId, bearer, fetcher = fetch) {
    if (!/^[0-9a-f-]{36}$/i.test(projectId))
        throw new Error('invalid_project_id');
    const request = async (method) => {
        const response = await fetcher(`${apiOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}/index`, {
            method,
            headers: { Authorization: `Bearer ${bearer}` },
        });
        if (!response.ok)
            throw new Error(`index_${method.toLowerCase()}_failed_${response.status}`);
        return (await response.json());
    };
    const confirmation = await request('DELETE');
    if (confirmation.projectId !== projectId || confirmation.status !== 'deleted')
        throw new Error('index_delete_unconfirmed');
    const verified = await request('GET');
    if (verified.projectId !== projectId || verified.chunkCount !== 0)
        throw new Error('index_delete_not_verified');
    return {
        ...confirmation,
        chunkCount: 0,
        verbs: ['delete uploaded cloud data'],
        retained: ['local software', 'credentials', 'durable memories', 'tasks'],
    };
}
//# sourceMappingURL=data.js.map