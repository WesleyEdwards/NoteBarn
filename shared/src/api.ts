import type { Query, MassModification, EntryChange, ListChange, Modification, Condition, GroupCountQuery, AggregateQuery, GroupAggregateQuery, Aggregate, SortPart, DataClassPath, DataClassPathPartial, QueryPartial, DeepPartial, Fetcher, Brand } from '@lightningkite/lightning-server-simplified'

export interface AttachmentUpload {
	vault: Vault.ID
	hash: string
	size: number
}

export interface AttachmentUploadInfo {
	uploadUrl: string | null | undefined
}

export interface AttachmentUrls {
	vault: Vault.ID
	hashes: Array<string>
}

export interface AuthRequirements {
	options: Array<ProofOption>
	strengthRequired: number
}

export interface BulkRequest {
	path: string
	method: string
	body: string | null | undefined
}

export interface BulkResponse {
	result: string | null | undefined
	error: LSError | null | undefined
	durationMs: number
}

export interface ChangesRequest {
	vault: Vault.ID
	since: number
	limit: number
}

export interface ChangesResponse {
	notes: Array<Note>
	cursor: number
	hasMore: boolean
	latestVersion: number
}

export type DataSize = Brand<number, "DataSize">

export interface DeleteNote {
	vault: Vault.ID
	path: string
	baseVersion: number | null | undefined
}

export type EmailAddress = string  // com.lightningkite.services.data.EmailAddress

export interface FinishProof {
	key: string
	password: string
}

export type GrantedScope = Brand<string, "GrantedScope">

export interface HealthStatus {
	level: HealthStatus.Level
	checkedAt: Instant
	additionalMessage: string | null | undefined
}

export namespace HealthStatus {
	export type Level = "OK"| "WARNING"| "URGENT"| "ERROR"
}

export interface IdAndAuthMethods<T> {
	id: T
	options: Array<ProofOption>
	strengthRequired: number
	refreshToken: string | null | undefined
	session: string | null | undefined
}

export type Instant = string  // kotlin.time.Instant

export interface LSError {
	http: number
	detail: string
	message: string
	data: string
	stackTrace: string | null | undefined
}

export interface LogInRequest {
	proofs: Array<Proof>
	label: string
	scopes: Array<GrantedScope>
	expires: Instant | null | undefined
}

export interface Manifest {
	notes: Array<NoteSummary>
	latestVersion: number
}

export interface Mask<T> {
	pairs: Array<Pair<Condition<T>, Modification<T>>>
}

export interface ModelPermissions<T> {
	create: Condition<T>
	read: Condition<T>
	readMask: Mask<T>
	update: Condition<T>
	updateRestrictions: UpdateRestrictions<T>
	delete: Condition<T>
	maxQueryTimeMs: number
}

export interface Note {
	_id: Note.ID
	owner: User.ID
	vault: Vault.ID
	path: string
	content: string
	hash: string
	size: number
	version: number
	modifiedAt: Instant
	deleted: boolean
	attachment: boolean
}

export namespace Note {
	export type ID = Brand<Uuid, "Note.ID">
}

export interface NoteHistoryRequest {
	vault: Vault.ID
	path: string
}

export interface NoteSummary {
	path: string
	version: number
	hash: string
	size: number
	modifiedAt: Instant
	deleted: boolean
	attachment: boolean
}

export interface NoteVersionContent {
	id: NoteVersion.ID
	path: string
	content: string
	hash: string
	size: number
	attachment: boolean
	version: number
	modifiedAt: Instant
	savedAt: Instant
	reason: VersionReason
}

export interface NoteVersionSummary {
	id: NoteVersion.ID
	path: string
	size: number
	attachment: boolean
	version: number
	modifiedAt: Instant
	savedAt: Instant
	reason: VersionReason
}

export interface Pair<T, T1> {
	first: T
	second: T1
}

export interface Proof {
	via: string
	strength: number
	property: string
	value: string
	at: Instant
	expiresAt: Instant | null | undefined
	signature: string
}

export interface ProofMethodInfo {
	via: string
	property: string | null | undefined
	strength: number
}

export interface ProofOption {
	method: ProofMethodInfo
	value: string | null | undefined
}

export interface ProofsCheckResult<T> {
	id: T
	options: Array<ProofOption>
	strengthRequired: number
	readyToLogIn: boolean
	maxExpiration: Instant | null | undefined
}

export interface ReadNote {
	vault: Vault.ID
	path: string
}

export interface ReadVersion {
	vault: Vault.ID
	id: NoteVersion.ID
}

export interface RenameNote {
	vault: Vault.ID
	from: string
	to: string
	baseVersion: number | null | undefined
}

export interface RestoreVersion {
	vault: Vault.ID
	id: NoteVersion.ID
	baseVersion: number | null | undefined
}

export interface SearchHit {
	path: string
	snippet: string | null | undefined
}

export interface SearchNotes {
	vault: Vault.ID
	query: string
	limit: number
}

export interface ServerHealth {
	serverId: string
	version: string
	memory: ServerHealth.Memory
	features: Record<string, HealthStatus>
	loadAverageCpu: number
}

export namespace ServerHealth {
	export interface Memory {
		max: DataSize
		total: DataSize
		free: DataSize
		systemAllocated: DataSize
		usage: number
	}
}

export interface Session<T, T1> {
	_id: Uuid
	secretHash: string
	derivedFrom: Uuid | null | undefined
	label: string | null | undefined
	subjectId: T1
	createdAt: Instant
	lastUsed: Instant
	expires: Instant | null | undefined
	stale: Instant | null | undefined
	terminated: Instant | null | undefined
	ips: Array<string>
	userAgents: Array<string>
	scopes: Array<GrantedScope>
}

export interface Share {
	_id: Share.ID
	owner: User.ID
	vault: Vault.ID
	path: string
	createdAt: Instant
}

export namespace Share {
	export type ID = Brand<Uuid, "Share.ID">
}

export interface ShareNote {
	vault: Vault.ID
	path: string
}

export interface SharedAttachment {
	target: string
	hash: string
	url: string
}

export interface SharedNote {
	title: string
	content: string
	modifiedAt: Instant
	attachments: Array<SharedAttachment>
}

export interface SubSessionRequest {
	label: string
	scopes: Array<GrantedScope>
	oauthClient: string | null | undefined
	expires: Instant | null | undefined
}

export interface UpdateRestrictions<T> {
	mode: UpdateRestrictions.Mode
	fields: Array<UpdateRestrictions.Part<T>>
}

export namespace UpdateRestrictions {
	export type Mode = "Blacklist"| "Whitelist"

	export interface Part<T> {
		property: DataClassPathPartial<T>
		requires: Condition<T>
		limitedTo: Condition<T>
	}
}

export interface User {
	_id: User.ID
	email: EmailAddress
	role: UserRole
}

export namespace User {
	export type ID = Brand<Uuid, "User.ID">
}

export type UserRole = "User"| "Admin"| "Root"

export type Uuid = string  // kotlin.uuid.Uuid

export interface Vault {
	_id: Vault.ID
	owner: User.ID
	name: string
	createdAt: Instant
	latestVersion: number
}

export namespace Vault {
	export type ID = Brand<Uuid, "Vault.ID">
}

export interface VaultChanged {
	vault: Vault.ID
	latestVersion: number
}

export type VersionReason = "Edit"| "Delete"

export interface WriteAttachment {
	vault: Vault.ID
	path: string
	hash: string
	baseVersion: number | null | undefined
}

export interface WriteNote {
	vault: Vault.ID
	path: string
	content: string
	baseVersion: number | null | undefined
}

export interface WriteResult {
	success: boolean
	note: Note | null | undefined
}

export namespace NoteVersion {
	export type ID = Brand<Uuid, "NoteVersion.ID">
}




export interface Api {

	readonly user: {
		list(input: Query<User>): Promise<Array<User>>
		insert(input: User): Promise<User>
		permissions(): Promise<ModelPermissions<User>>
		queryPartial(input: QueryPartial<User>): Promise<Array<Partial<User>>>
		groupAggregate2(input: GroupAggregateQuery<User>): Promise<Record<string, number | null | undefined>>
		groupAggregate(input: GroupAggregateQuery<User>): Promise<Record<string, number | null | undefined>>
		query(input: Query<User>): Promise<Array<User>>
		count(input: Condition<User>): Promise<number>
		groupCount(input: GroupCountQuery<User>): Promise<Record<string, number>>
		insertBulk(input: Array<User>): Promise<Array<User>>
		bulkReplace(input: Array<User>): Promise<Array<User>>
		bulkModify(input: MassModification<User>): Promise<number>
		groupCount2(input: GroupCountQuery<User>): Promise<Record<string, number>>
		bulkDelete(input: Condition<User>): Promise<number>
		aggregate(input: AggregateQuery<User>): Promise<number | null | undefined>
		detail(id: User.ID): Promise<User>
		upsert(id: User.ID, input: User): Promise<User>
		replace(id: User.ID, input: User): Promise<User>
		modify(id: User.ID, input: Modification<User>): Promise<User>
		delete(id: User.ID): Promise<void>
		simplifiedModify(id: User.ID, input: Partial<User>): Promise<User>
		modifyWithDiff(id: User.ID, input: Modification<User>): Promise<EntryChange<User>>
	}
	readonly userAuth: {
		getSelf(): Promise<User>
		terminateCurrentSession(): Promise<void>
		logIn(input: Array<Proof>): Promise<IdAndAuthMethods<User.ID>>
		checkProofs(input: Array<Proof>): Promise<ProofsCheckResult<User.ID>>
		createSubSession(input: SubSessionRequest): Promise<string>
		authenticationRequirements(): Promise<AuthRequirements>
		logInWithLimitations(input: LogInRequest): Promise<IdAndAuthMethods<User.ID>>
		getTokenSimple(input: string): Promise<string>
		terminateSession(sessionId: Uuid): Promise<void>
		list(input: Query<Session<User, User.ID>>): Promise<Array<Session<User, User.ID>>>
		insert(input: Session<User, User.ID>): Promise<Session<User, User.ID>>
		permissions(): Promise<ModelPermissions<Session<User, User.ID>>>
		queryPartial(input: QueryPartial<Session<User, User.ID>>): Promise<Array<Partial<Session<User, User.ID>>>>
		groupAggregate2(input: GroupAggregateQuery<Session<User, User.ID>>): Promise<Record<string, number | null | undefined>>
		groupAggregate(input: GroupAggregateQuery<Session<User, User.ID>>): Promise<Record<string, number | null | undefined>>
		query(input: Query<Session<User, User.ID>>): Promise<Array<Session<User, User.ID>>>
		count(input: Condition<Session<User, User.ID>>): Promise<number>
		groupCount(input: GroupCountQuery<Session<User, User.ID>>): Promise<Record<string, number>>
		insertBulk(input: Array<Session<User, User.ID>>): Promise<Array<Session<User, User.ID>>>
		bulkReplace(input: Array<Session<User, User.ID>>): Promise<Array<Session<User, User.ID>>>
		bulkModify(input: MassModification<Session<User, User.ID>>): Promise<number>
		groupCount2(input: GroupCountQuery<Session<User, User.ID>>): Promise<Record<string, number>>
		bulkDelete(input: Condition<Session<User, User.ID>>): Promise<number>
		aggregate(input: AggregateQuery<Session<User, User.ID>>): Promise<number | null | undefined>
		detail(id: Uuid): Promise<Session<User, User.ID>>
		upsert(id: Uuid, input: Session<User, User.ID>): Promise<Session<User, User.ID>>
		replace(id: Uuid, input: Session<User, User.ID>): Promise<Session<User, User.ID>>
		modify(id: Uuid, input: Modification<Session<User, User.ID>>): Promise<Session<User, User.ID>>
		delete(id: Uuid): Promise<void>
		simplifiedModify(id: Uuid, input: Partial<Session<User, User.ID>>): Promise<Session<User, User.ID>>
		modifyWithDiff(id: Uuid, input: Modification<Session<User, User.ID>>): Promise<EntryChange<Session<User, User.ID>>>
		proveEmailOwnership(input: FinishProof): Promise<Proof>
		beginEmailOwnershipProof(input: string): Promise<string>
	}
	readonly vault: {
		list(input: Query<Vault>): Promise<Array<Vault>>
		insert(input: Vault): Promise<Vault>
		permissions(): Promise<ModelPermissions<Vault>>
		queryPartial(input: QueryPartial<Vault>): Promise<Array<Partial<Vault>>>
		groupAggregate2(input: GroupAggregateQuery<Vault>): Promise<Record<string, number | null | undefined>>
		groupAggregate(input: GroupAggregateQuery<Vault>): Promise<Record<string, number | null | undefined>>
		query(input: Query<Vault>): Promise<Array<Vault>>
		count(input: Condition<Vault>): Promise<number>
		groupCount(input: GroupCountQuery<Vault>): Promise<Record<string, number>>
		insertBulk(input: Array<Vault>): Promise<Array<Vault>>
		bulkReplace(input: Array<Vault>): Promise<Array<Vault>>
		bulkModify(input: MassModification<Vault>): Promise<number>
		groupCount2(input: GroupCountQuery<Vault>): Promise<Record<string, number>>
		bulkDelete(input: Condition<Vault>): Promise<number>
		aggregate(input: AggregateQuery<Vault>): Promise<number | null | undefined>
		detail(id: Vault.ID): Promise<Vault>
		upsert(id: Vault.ID, input: Vault): Promise<Vault>
		replace(id: Vault.ID, input: Vault): Promise<Vault>
		modify(id: Vault.ID, input: Modification<Vault>): Promise<Vault>
		delete(id: Vault.ID): Promise<void>
		simplifiedModify(id: Vault.ID, input: Partial<Vault>): Promise<Vault>
		modifyWithDiff(id: Vault.ID, input: Modification<Vault>): Promise<EntryChange<Vault>>
	}
	readonly note: {
		attachmentUpload(input: AttachmentUpload): Promise<AttachmentUploadInfo>
		readNote(input: ReadNote): Promise<Note | null | undefined>
		restoreVersion(input: RestoreVersion): Promise<WriteResult>
		vaultManifest(input: Vault.ID): Promise<Manifest>
		noteChanges(input: ChangesRequest): Promise<ChangesResponse>
		writeAttachment(input: WriteAttachment): Promise<WriteResult>
		noteHistory(input: NoteHistoryRequest): Promise<Array<NoteVersionSummary>>
		attachmentLinks(input: AttachmentUrls): Promise<Array<string>>
		deleteNote(input: DeleteNote): Promise<WriteResult>
		noteVersion(input: ReadVersion): Promise<NoteVersionContent>
		searchNotes(input: SearchNotes): Promise<Array<SearchHit>>
		recentlyDeleted(input: Vault.ID): Promise<Array<NoteVersionSummary>>
		renameNote(input: RenameNote): Promise<WriteResult>
		writeNote(input: WriteNote): Promise<WriteResult>
		list(input: Query<Note>): Promise<Array<Note>>
		insert(input: Note): Promise<Note>
		permissions(): Promise<ModelPermissions<Note>>
		queryPartial(input: QueryPartial<Note>): Promise<Array<Partial<Note>>>
		groupAggregate2(input: GroupAggregateQuery<Note>): Promise<Record<string, number | null | undefined>>
		groupAggregate(input: GroupAggregateQuery<Note>): Promise<Record<string, number | null | undefined>>
		query(input: Query<Note>): Promise<Array<Note>>
		count(input: Condition<Note>): Promise<number>
		groupCount(input: GroupCountQuery<Note>): Promise<Record<string, number>>
		insertBulk(input: Array<Note>): Promise<Array<Note>>
		bulkReplace(input: Array<Note>): Promise<Array<Note>>
		bulkModify(input: MassModification<Note>): Promise<number>
		groupCount2(input: GroupCountQuery<Note>): Promise<Record<string, number>>
		bulkDelete(input: Condition<Note>): Promise<number>
		aggregate(input: AggregateQuery<Note>): Promise<number | null | undefined>
		detail(id: Note.ID): Promise<Note>
		upsert(id: Note.ID, input: Note): Promise<Note>
		replace(id: Note.ID, input: Note): Promise<Note>
		modify(id: Note.ID, input: Modification<Note>): Promise<Note>
		delete(id: Note.ID): Promise<void>
		simplifiedModify(id: Note.ID, input: Partial<Note>): Promise<Note>
		modifyWithDiff(id: Note.ID, input: Modification<Note>): Promise<EntryChange<Note>>
	}
	readonly share: {
		viewSharedNote(input: Share.ID): Promise<SharedNote>
		stopSharing(input: ShareNote): Promise<void>
		shareNote(input: ShareNote): Promise<Share>
		list(input: Query<Share>): Promise<Array<Share>>
		insert(input: Share): Promise<Share>
		permissions(): Promise<ModelPermissions<Share>>
		queryPartial(input: QueryPartial<Share>): Promise<Array<Partial<Share>>>
		groupAggregate2(input: GroupAggregateQuery<Share>): Promise<Record<string, number | null | undefined>>
		groupAggregate(input: GroupAggregateQuery<Share>): Promise<Record<string, number | null | undefined>>
		query(input: Query<Share>): Promise<Array<Share>>
		count(input: Condition<Share>): Promise<number>
		groupCount(input: GroupCountQuery<Share>): Promise<Record<string, number>>
		insertBulk(input: Array<Share>): Promise<Array<Share>>
		bulkReplace(input: Array<Share>): Promise<Array<Share>>
		bulkModify(input: MassModification<Share>): Promise<number>
		groupCount2(input: GroupCountQuery<Share>): Promise<Record<string, number>>
		bulkDelete(input: Condition<Share>): Promise<number>
		aggregate(input: AggregateQuery<Share>): Promise<number | null | undefined>
		detail(id: Share.ID): Promise<Share>
		upsert(id: Share.ID, input: Share): Promise<Share>
		replace(id: Share.ID, input: Share): Promise<Share>
		modify(id: Share.ID, input: Modification<Share>): Promise<Share>
		delete(id: Share.ID): Promise<void>
		simplifiedModify(id: Share.ID, input: Partial<Share>): Promise<Share>
		modifyWithDiff(id: Share.ID, input: Modification<Share>): Promise<EntryChange<Share>>
	}
	readonly fileSystem: {
	}
	readonly meta: {
		getServerHealth(): Promise<ServerHealth>
		bulkRequest(input: Record<string, BulkRequest>): Promise<Record<string, BulkResponse>>
	}
}



export class LiveApi implements Api {
	public fetcher: Fetcher
	public constructor(fetcher: Fetcher) {
		this.fetcher = fetcher
	}


	readonly user: Api["user"] = {
		list: (input) => this.fetcher(`/users`, "GET", input),
		insert: (input) => this.fetcher(`/users`, "POST", input),
		permissions: () => this.fetcher(`/users/_permissions_`, "GET", undefined),
		queryPartial: (input) => this.fetcher(`/users/query-partial`, "POST", input),
		groupAggregate2: (input) => this.fetcher(`/users/group-aggregate-2`, "POST", input),
		groupAggregate: (input) => this.fetcher(`/users/group-aggregate`, "POST", input),
		query: (input) => this.fetcher(`/users/query`, "POST", input),
		count: (input) => this.fetcher(`/users/count`, "POST", input),
		groupCount: (input) => this.fetcher(`/users/group-count`, "POST", input),
		insertBulk: (input) => this.fetcher(`/users/bulk`, "POST", input),
		bulkReplace: (input) => this.fetcher(`/users/bulk`, "PUT", input),
		bulkModify: (input) => this.fetcher(`/users/bulk`, "PATCH", input),
		groupCount2: (input) => this.fetcher(`/users/group-count-2`, "POST", input),
		bulkDelete: (input) => this.fetcher(`/users/bulk-delete`, "POST", input),
		aggregate: (input) => this.fetcher(`/users/aggregate`, "POST", input),
		detail: (id) => this.fetcher(`/users/${id}`, "GET", undefined),
		upsert: (id, input) => this.fetcher(`/users/${id}`, "POST", input),
		replace: (id, input) => this.fetcher(`/users/${id}`, "PUT", input),
		modify: (id, input) => this.fetcher(`/users/${id}`, "PATCH", input),
		delete: (id) => this.fetcher(`/users/${id}`, "DELETE", undefined),
		simplifiedModify: (id, input) => this.fetcher(`/users/${id}/simplified`, "PATCH", input),
		modifyWithDiff: (id, input) => this.fetcher(`/users/${id}/delta`, "PATCH", input),
	}
	readonly userAuth: Api["userAuth"] = {
		getSelf: () => this.fetcher(`/auth/session/self`, "GET", undefined),
		terminateCurrentSession: () => this.fetcher(`/auth/session/terminate`, "POST", undefined),
		logIn: (input) => this.fetcher(`/auth/session/login`, "POST", input),
		checkProofs: (input) => this.fetcher(`/auth/session/proofs-check`, "POST", input),
		createSubSession: (input) => this.fetcher(`/auth/session/sub-session`, "POST", input),
		authenticationRequirements: () => this.fetcher(`/auth/session/auth-requirements`, "GET", undefined),
		logInWithLimitations: (input) => this.fetcher(`/auth/session/login2`, "POST", input),
		getTokenSimple: (input) => this.fetcher(`/auth/session/token/simple`, "POST", input),
		terminateSession: (sessionId) => this.fetcher(`/auth/session/${sessionId}/terminate`, "POST", undefined),
		list: (input) => this.fetcher(`/auth/session/sessions`, "GET", input),
		insert: (input) => this.fetcher(`/auth/session/sessions`, "POST", input),
		permissions: () => this.fetcher(`/auth/session/sessions/_permissions_`, "GET", undefined),
		queryPartial: (input) => this.fetcher(`/auth/session/sessions/query-partial`, "POST", input),
		groupAggregate2: (input) => this.fetcher(`/auth/session/sessions/group-aggregate-2`, "POST", input),
		groupAggregate: (input) => this.fetcher(`/auth/session/sessions/group-aggregate`, "POST", input),
		query: (input) => this.fetcher(`/auth/session/sessions/query`, "POST", input),
		count: (input) => this.fetcher(`/auth/session/sessions/count`, "POST", input),
		groupCount: (input) => this.fetcher(`/auth/session/sessions/group-count`, "POST", input),
		insertBulk: (input) => this.fetcher(`/auth/session/sessions/bulk`, "POST", input),
		bulkReplace: (input) => this.fetcher(`/auth/session/sessions/bulk`, "PUT", input),
		bulkModify: (input) => this.fetcher(`/auth/session/sessions/bulk`, "PATCH", input),
		groupCount2: (input) => this.fetcher(`/auth/session/sessions/group-count-2`, "POST", input),
		bulkDelete: (input) => this.fetcher(`/auth/session/sessions/bulk-delete`, "POST", input),
		aggregate: (input) => this.fetcher(`/auth/session/sessions/aggregate`, "POST", input),
		detail: (id) => this.fetcher(`/auth/session/sessions/${id}`, "GET", undefined),
		upsert: (id, input) => this.fetcher(`/auth/session/sessions/${id}`, "POST", input),
		replace: (id, input) => this.fetcher(`/auth/session/sessions/${id}`, "PUT", input),
		modify: (id, input) => this.fetcher(`/auth/session/sessions/${id}`, "PATCH", input),
		delete: (id) => this.fetcher(`/auth/session/sessions/${id}`, "DELETE", undefined),
		simplifiedModify: (id, input) => this.fetcher(`/auth/session/sessions/${id}/simplified`, "PATCH", input),
		modifyWithDiff: (id, input) => this.fetcher(`/auth/session/sessions/${id}/delta`, "PATCH", input),
		proveEmailOwnership: (input) => this.fetcher(`/auth/proof/email/prove`, "POST", input),
		beginEmailOwnershipProof: (input) => this.fetcher(`/auth/proof/email/start`, "POST", input),
	}
	readonly vault: Api["vault"] = {
		list: (input) => this.fetcher(`/vault`, "GET", input),
		insert: (input) => this.fetcher(`/vault`, "POST", input),
		permissions: () => this.fetcher(`/vault/_permissions_`, "GET", undefined),
		queryPartial: (input) => this.fetcher(`/vault/query-partial`, "POST", input),
		groupAggregate2: (input) => this.fetcher(`/vault/group-aggregate-2`, "POST", input),
		groupAggregate: (input) => this.fetcher(`/vault/group-aggregate`, "POST", input),
		query: (input) => this.fetcher(`/vault/query`, "POST", input),
		count: (input) => this.fetcher(`/vault/count`, "POST", input),
		groupCount: (input) => this.fetcher(`/vault/group-count`, "POST", input),
		insertBulk: (input) => this.fetcher(`/vault/bulk`, "POST", input),
		bulkReplace: (input) => this.fetcher(`/vault/bulk`, "PUT", input),
		bulkModify: (input) => this.fetcher(`/vault/bulk`, "PATCH", input),
		groupCount2: (input) => this.fetcher(`/vault/group-count-2`, "POST", input),
		bulkDelete: (input) => this.fetcher(`/vault/bulk-delete`, "POST", input),
		aggregate: (input) => this.fetcher(`/vault/aggregate`, "POST", input),
		detail: (id) => this.fetcher(`/vault/${id}`, "GET", undefined),
		upsert: (id, input) => this.fetcher(`/vault/${id}`, "POST", input),
		replace: (id, input) => this.fetcher(`/vault/${id}`, "PUT", input),
		modify: (id, input) => this.fetcher(`/vault/${id}`, "PATCH", input),
		delete: (id) => this.fetcher(`/vault/${id}`, "DELETE", undefined),
		simplifiedModify: (id, input) => this.fetcher(`/vault/${id}/simplified`, "PATCH", input),
		modifyWithDiff: (id, input) => this.fetcher(`/vault/${id}/delta`, "PATCH", input),
	}
	readonly note: Api["note"] = {
		attachmentUpload: (input) => this.fetcher(`/note/attachment-upload`, "POST", input),
		readNote: (input) => this.fetcher(`/note/read`, "POST", input),
		restoreVersion: (input) => this.fetcher(`/note/restore`, "POST", input),
		vaultManifest: (input) => this.fetcher(`/note/manifest`, "POST", input),
		noteChanges: (input) => this.fetcher(`/note/changes`, "POST", input),
		writeAttachment: (input) => this.fetcher(`/note/write-attachment`, "POST", input),
		noteHistory: (input) => this.fetcher(`/note/history`, "POST", input),
		attachmentLinks: (input) => this.fetcher(`/note/attachment-urls`, "POST", input),
		deleteNote: (input) => this.fetcher(`/note/delete`, "POST", input),
		noteVersion: (input) => this.fetcher(`/note/version`, "POST", input),
		searchNotes: (input) => this.fetcher(`/note/search`, "POST", input),
		recentlyDeleted: (input) => this.fetcher(`/note/deleted`, "POST", input),
		renameNote: (input) => this.fetcher(`/note/rename`, "POST", input),
		writeNote: (input) => this.fetcher(`/note/write`, "POST", input),
		list: (input) => this.fetcher(`/note`, "GET", input),
		insert: (input) => this.fetcher(`/note`, "POST", input),
		permissions: () => this.fetcher(`/note/_permissions_`, "GET", undefined),
		queryPartial: (input) => this.fetcher(`/note/query-partial`, "POST", input),
		groupAggregate2: (input) => this.fetcher(`/note/group-aggregate-2`, "POST", input),
		groupAggregate: (input) => this.fetcher(`/note/group-aggregate`, "POST", input),
		query: (input) => this.fetcher(`/note/query`, "POST", input),
		count: (input) => this.fetcher(`/note/count`, "POST", input),
		groupCount: (input) => this.fetcher(`/note/group-count`, "POST", input),
		insertBulk: (input) => this.fetcher(`/note/bulk`, "POST", input),
		bulkReplace: (input) => this.fetcher(`/note/bulk`, "PUT", input),
		bulkModify: (input) => this.fetcher(`/note/bulk`, "PATCH", input),
		groupCount2: (input) => this.fetcher(`/note/group-count-2`, "POST", input),
		bulkDelete: (input) => this.fetcher(`/note/bulk-delete`, "POST", input),
		aggregate: (input) => this.fetcher(`/note/aggregate`, "POST", input),
		detail: (id) => this.fetcher(`/note/${id}`, "GET", undefined),
		upsert: (id, input) => this.fetcher(`/note/${id}`, "POST", input),
		replace: (id, input) => this.fetcher(`/note/${id}`, "PUT", input),
		modify: (id, input) => this.fetcher(`/note/${id}`, "PATCH", input),
		delete: (id) => this.fetcher(`/note/${id}`, "DELETE", undefined),
		simplifiedModify: (id, input) => this.fetcher(`/note/${id}/simplified`, "PATCH", input),
		modifyWithDiff: (id, input) => this.fetcher(`/note/${id}/delta`, "PATCH", input),
	}
	readonly share: Api["share"] = {
		viewSharedNote: (input) => this.fetcher(`/share/view`, "POST", input),
		stopSharing: (input) => this.fetcher(`/share/stop`, "POST", input),
		shareNote: (input) => this.fetcher(`/share/create`, "POST", input),
		list: (input) => this.fetcher(`/share`, "GET", input),
		insert: (input) => this.fetcher(`/share`, "POST", input),
		permissions: () => this.fetcher(`/share/_permissions_`, "GET", undefined),
		queryPartial: (input) => this.fetcher(`/share/query-partial`, "POST", input),
		groupAggregate2: (input) => this.fetcher(`/share/group-aggregate-2`, "POST", input),
		groupAggregate: (input) => this.fetcher(`/share/group-aggregate`, "POST", input),
		query: (input) => this.fetcher(`/share/query`, "POST", input),
		count: (input) => this.fetcher(`/share/count`, "POST", input),
		groupCount: (input) => this.fetcher(`/share/group-count`, "POST", input),
		insertBulk: (input) => this.fetcher(`/share/bulk`, "POST", input),
		bulkReplace: (input) => this.fetcher(`/share/bulk`, "PUT", input),
		bulkModify: (input) => this.fetcher(`/share/bulk`, "PATCH", input),
		groupCount2: (input) => this.fetcher(`/share/group-count-2`, "POST", input),
		bulkDelete: (input) => this.fetcher(`/share/bulk-delete`, "POST", input),
		aggregate: (input) => this.fetcher(`/share/aggregate`, "POST", input),
		detail: (id) => this.fetcher(`/share/${id}`, "GET", undefined),
		upsert: (id, input) => this.fetcher(`/share/${id}`, "POST", input),
		replace: (id, input) => this.fetcher(`/share/${id}`, "PUT", input),
		modify: (id, input) => this.fetcher(`/share/${id}`, "PATCH", input),
		delete: (id) => this.fetcher(`/share/${id}`, "DELETE", undefined),
		simplifiedModify: (id, input) => this.fetcher(`/share/${id}/simplified`, "PATCH", input),
		modifyWithDiff: (id, input) => this.fetcher(`/share/${id}/delta`, "PATCH", input),
	}
	readonly fileSystem: Api["fileSystem"] = {
	}
	readonly meta: Api["meta"] = {
		getServerHealth: () => this.fetcher(`/meta/health`, "GET", undefined),
		bulkRequest: (input) => this.fetcher(`/meta/bulk`, "POST", input),
	}
}
