import {useEffect, useState} from "react"
import {Link} from "react-router-dom"
import type {AdminStats, Api} from "@notebarn/shared/api"
import {errorMessage} from "../api/client"

// Claude: the Atlas free tier's cap. Atlas counts data plus indexes, uncompressed, toward it.
const ATLAS_LIMIT = 512 * 1024 * 1024

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** How much is on the server, and how close the database is to the Atlas free tier's limit. */
export function AdminPage({api}: {api: Api}) {
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.admin
      .adminStats()
      .then(setStats)
      .catch(async (e) =>
        setError(e instanceof Response && e.status === 403 ? "Only admins can see this page." : await errorMessage(e))
      )
  }, [api])

  const storage = stats?.storage
  const used = storage ? storage.dataSize + storage.indexSize : 0

  return (
    <div className="vaults">
      <div className="vaults-card">
        <h1>Admin</h1>
        {error && <p className="form-error">{error}</p>}
        {!stats && !error && <p className="hint">Loading…</p>}

        {stats && (
          <>
            <h2 className="admin-heading">Database storage</h2>
            {storage ? (
              <>
                <meter min={0} max={ATLAS_LIMIT} low={ATLAS_LIMIT * 0.6} high={ATLAS_LIMIT * 0.85} optimum={0} value={used} />
                <p className="admin-usage">
                  {mb(used)} of {mb(ATLAS_LIMIT)} ({((used / ATLAS_LIMIT) * 100).toFixed(1)}%)
                </p>
                <dl className="admin-stats">
                  <dt>Data</dt>
                  <dd>{mb(storage.dataSize)}</dd>
                  <dt>Indexes</dt>
                  <dd>{mb(storage.indexSize)}</dd>
                  <dt>On disk (compressed)</dt>
                  <dd>{mb(storage.storageSize)}</dd>
                </dl>
              </>
            ) : (
              <p className="hint">Only shown when the database is MongoDB.</p>
            )}

            <h2 className="admin-heading">Records</h2>
            <dl className="admin-stats">
              <dt>Users</dt>
              <dd>{stats.users}</dd>
              <dt>Vaults</dt>
              <dd>{stats.vaults}</dd>
              <dt>Notes and files</dt>
              <dd>{stats.notes}</dd>
              <dt>Note history copies</dt>
              <dd>{stats.noteVersions}</dd>
              <dt>Shares</dt>
              <dd>{stats.shares}</dd>
            </dl>
          </>
        )}

        <p className="vaults-footer">
          <Link className="link-button" to="/vaults">
            Back to vaults
          </Link>
        </p>
      </div>
    </div>
  )
}
