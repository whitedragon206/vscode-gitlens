import type {
	ColorTheme,
	ConfigurationChangeEvent,
	Event,
	StatusBarItem,
	WebviewOptions,
	WebviewPanelOptions,
} from 'vscode';
import {
	CancellationTokenSource,
	Disposable,
	env,
	EventEmitter,
	MarkdownString,
	StatusBarAlignment,
	ViewColumn,
	window,
} from 'vscode';
import type { CreatePullRequestActionContext } from '../../../api/gitlens';
import { getAvatarUri } from '../../../avatars';
import type {
	CopyMessageToClipboardCommandArgs,
	CopyShaToClipboardCommandArgs,
	OpenBranchOnRemoteCommandArgs,
	OpenCommitOnRemoteCommandArgs,
	OpenPullRequestOnRemoteCommandArgs,
	ShowCommitsInViewCommandArgs,
} from '../../../commands';
import { parseCommandContext } from '../../../commands/base';
import { GitActions } from '../../../commands/gitCommands.actions';
import type { Config } from '../../../configuration';
import { configuration } from '../../../configuration';
import { Commands, ContextKeys, CoreGitCommands } from '../../../constants';
import type { Container } from '../../../container';
import { getContext, onDidChangeContext, setContext } from '../../../context';
import { PlusFeatures } from '../../../features';
import { GitSearchError } from '../../../git/errors';
import { getBranchNameWithoutRemote, getRemoteNameFromBranchName } from '../../../git/models/branch';
import type { GitCommit } from '../../../git/models/commit';
import { GitContributor } from '../../../git/models/contributor';
import { GitGraphRowType } from '../../../git/models/graph';
import type { GitGraph } from '../../../git/models/graph';
import type {
	GitBranchReference,
	GitRevisionReference,
	GitStashReference,
	GitTagReference,
} from '../../../git/models/reference';
import { GitReference, GitRevision } from '../../../git/models/reference';
import { getRemoteIconUri } from '../../../git/models/remote';
import type {
	Repository,
	RepositoryChangeEvent,
	RepositoryFileSystemChangeEvent,
} from '../../../git/models/repository';
import { RepositoryChange, RepositoryChangeComparisonMode } from '../../../git/models/repository';
import type { GitSearch } from '../../../git/search';
import { getSearchQueryComparisonKey } from '../../../git/search';
import type { StoredGraphHiddenRef } from '../../../storage';
import { executeActionCommand, executeCommand, executeCoreGitCommand, registerCommand } from '../../../system/command';
import { gate } from '../../../system/decorators/gate';
import { debug } from '../../../system/decorators/log';
import type { Deferrable } from '../../../system/function';
import { debounce, once } from '../../../system/function';
import { last } from '../../../system/iterable';
import { updateRecordValue } from '../../../system/object';
import { getSettledValue } from '../../../system/promise';
import { isDarkTheme, isLightTheme } from '../../../system/utils';
import type { WebviewItemContext, WebviewItemGroupContext } from '../../../system/webview';
import { isWebviewItemContext, isWebviewItemGroupContext, serializeWebviewItemContext } from '../../../system/webview';
import type { BranchNode } from '../../../views/nodes/branchNode';
import type { CommitFileNode } from '../../../views/nodes/commitFileNode';
import type { CommitNode } from '../../../views/nodes/commitNode';
import type { StashNode } from '../../../views/nodes/stashNode';
import type { TagNode } from '../../../views/nodes/tagNode';
import { RepositoryFolderNode } from '../../../views/nodes/viewNode';
import { onIpc } from '../../../webviews/protocol';
import type { IpcMessage, IpcMessageParams, IpcNotificationType } from '../../../webviews/protocol';
import { WebviewBase } from '../../../webviews/webviewBase';
import type { SubscriptionChangeEvent } from '../../subscription/subscriptionService';
import { arePlusFeaturesEnabled, ensurePlusFeaturesEnabled } from '../../subscription/utils';
import type {
	DismissBannerParams,
	DoubleClickedRefParams,
	EnsureRowParams,
	GetMissingAvatarsParams,
	GetMissingRefsMetadataParams,
	GetMoreRowsParams,
	GraphColumnConfig,
	GraphColumnName,
	GraphColumnsSettings,
	GraphComponentConfig,
	GraphHiddenRef,
	GraphHiddenRefs,
	GraphHostingServiceType,
	GraphMissingRefsMetadataType,
	GraphPullRequestMetadata,
	GraphRefMetadata,
	GraphRepository,
	GraphSelectedRows,
	GraphWorkingTreeStats,
	SearchOpenInViewParams,
	SearchParams,
	State,
	UpdateColumnParams,
	UpdateRefsVisibilityParams,
	UpdateSelectedRepositoryParams,
	UpdateSelectionParams,
} from './protocol';
import {
	DidChangeAvatarsNotificationType,
	DidChangeColumnsNotificationType,
	DidChangeGraphConfigurationNotificationType,
	DidChangeNotificationType,
	DidChangeRefsMetadataNotificationType,
	DidChangeRefsVisibilityNotificationType,
	DidChangeRowsNotificationType,
	DidChangeSelectionNotificationType,
	DidChangeSubscriptionNotificationType,
	DidChangeWorkingTreeNotificationType,
	DidEnsureRowNotificationType,
	DidSearchNotificationType,
	DismissBannerCommandType,
	DoubleClickedRefCommandType,
	EnsureRowCommandType,
	GetMissingAvatarsCommandType,
	GetMissingRefsMetadataCommandType,
	GetMoreRowsCommandType,
	SearchCommandType,
	SearchOpenInViewCommandType,
	UpdateColumnCommandType,
	UpdateRefsVisibilityCommandType,
	UpdateSelectedRepositoryCommandType,
	UpdateSelectionCommandType,
} from './protocol';

export interface ShowInCommitGraphCommandArgs {
	ref: GitReference;
	preserveFocus?: boolean;
}

export interface GraphSelectionChangeEvent {
	readonly selection: GitCommit[];
}

const defaultGraphColumnsSettings: GraphColumnsSettings = {
	ref: { width: 150, isHidden: false },
	graph: { width: 150, isHidden: false },
	message: { width: 300, isHidden: false },
	author: { width: 130, isHidden: false },
	datetime: { width: 130, isHidden: false },
	sha: { width: 130, isHidden: false },
};

export class GraphWebview extends WebviewBase<State> {
	private _onDidChangeSelection = new EventEmitter<GraphSelectionChangeEvent>();
	get onDidChangeSelection(): Event<GraphSelectionChangeEvent> {
		return this._onDidChangeSelection.event;
	}

	private _repository?: Repository;
	get repository(): Repository | undefined {
		return this._repository;
	}

	set repository(value: Repository | undefined) {
		if (this._repository === value) return;

		this._repositoryEventsDisposable?.dispose();
		this._repository = value;
		this.resetRepositoryState();

		if (value != null) {
			this._repositoryEventsDisposable = Disposable.from(
				value.onDidChange(this.onRepositoryChanged, this),
				value.startWatchingFileSystem(),
				value.onDidChangeFileSystem(this.onRepositoryFileSystemChanged, this),
				onDidChangeContext(key => {
					if (key !== ContextKeys.HasConnectedRemotes) return;

					this.resetRefsMetadata();
					this.updateRefsMetadata();
				}),
			);
		}

		if (this.isReady) {
			this.updateState();
		}
	}

	private _selection: readonly GitCommit[] | undefined;
	get selection(): readonly GitCommit[] | undefined {
		return this._selection;
	}

	private _etagSubscription?: number;
	private _etagRepository?: number;
	private _firstSelection = true;
	private _graph?: GitGraph;
	private _pendingIpcNotifications = new Map<IpcNotificationType, IpcMessage | (() => Promise<boolean>)>();
	private _refsMetadata: Map<string, GraphRefMetadata | null> | null | undefined;
	private _search: GitSearch | undefined;
	private _searchCancellation: CancellationTokenSource | undefined;
	private _selectedId?: string;
	private _selectedRows: GraphSelectedRows | undefined;
	private _showDetailsView: Config['graph']['showDetailsView'];
	private _statusBarItem: StatusBarItem | undefined;
	private _theme: ColorTheme | undefined;
	private _repositoryEventsDisposable: Disposable | undefined;

	private previewBanner?: boolean;
	private trialBanner?: boolean;

	constructor(container: Container) {
		super(
			container,
			'gitlens.graph',
			'graph.html',
			'images/gitlens-icon.png',
			'Commit Graph',
			'graphWebview',
			Commands.ShowGraphPage,
		);

		this._showDetailsView = configuration.get('graph.showDetailsView');

		this.disposables.push(
			configuration.onDidChange(this.onConfigurationChanged, this),
			once(container.onReady)(() => queueMicrotask(() => this.updateStatusBar())),
			onDidChangeContext(key => {
				if (key !== ContextKeys.Enabled && key !== ContextKeys.PlusEnabled) return;
				this.updateStatusBar();
			}),
			{ dispose: () => this._statusBarItem?.dispose() },
			registerCommand(
				Commands.ShowInCommitGraph,
				async (
					args: ShowInCommitGraphCommandArgs | BranchNode | CommitNode | CommitFileNode | StashNode | TagNode,
				) => {
					this.repository = this.container.git.getRepository(args.ref.repoPath);
					let id = args.ref.ref;
					if (!GitRevision.isSha(id)) {
						id = await this.container.git.resolveReference(args.ref.repoPath, id, undefined, {
							force: true,
						});
					}
					this.setSelectedRows(id);

					const preserveFocus = 'preserveFocus' in args ? args.preserveFocus ?? false : false;
					if (this._panel == null) {
						void this.show({ preserveFocus: preserveFocus });
					} else {
						this._panel.reveal(this._panel.viewColumn ?? ViewColumn.Active, preserveFocus ?? false);
						if (this._graph?.ids.has(id)) {
							void this.notifyDidChangeSelection();
							return;
						}

						this.setSelectedRows(id);
						void this.onGetMoreRows({ id: id }, true);
					}
				},
			),
		);
	}

	protected override get options(): WebviewPanelOptions & WebviewOptions {
		return {
			retainContextWhenHidden: true,
			enableFindWidget: false,
			enableCommandUris: true,
			enableScripts: true,
		};
	}

	override async show(options?: { column?: ViewColumn; preserveFocus?: boolean }, ...args: unknown[]): Promise<void> {
		this._firstSelection = true;
		if (!(await ensurePlusFeaturesEnabled())) return;

		if (this.container.git.repositoryCount > 1) {
			const [contexts] = parseCommandContext(Commands.ShowGraphPage, undefined, ...args);
			const context = Array.isArray(contexts) ? contexts[0] : contexts;

			if (context.type === 'scm' && context.scm.rootUri != null) {
				const repository = this.container.git.getRepository(context.scm.rootUri);
				if (repository != null) {
					this.repository = repository;
				}
			} else if (context.type === 'viewItem' && context.node instanceof RepositoryFolderNode) {
				this.repository = context.node.repo;
			}

			if (this.repository != null && this.isReady) {
				this.updateState();
			}
		}

		return super.show({ column: ViewColumn.Active, ...options }, ...args);
	}

	protected override refresh(force?: boolean): Promise<void> {
		this.resetRepositoryState();
		if (force) {
			this._pendingIpcNotifications.clear();
		}
		return super.refresh(force);
	}

	protected override async includeBootstrap(): Promise<State> {
		return this.getState(true);
	}

	protected override registerCommands(): Disposable[] {
		return [
			registerCommand(Commands.RefreshGraphPage, () => this.refresh(true)),
			registerCommand('gitlens.graph.createBranch', this.createBranch, this),
			registerCommand('gitlens.graph.deleteBranch', this.deleteBranch, this),
			registerCommand('gitlens.graph.copyRemoteBranchUrl', item => this.openBranchOnRemote(item, true), this),
			registerCommand('gitlens.graph.openBranchOnRemote', this.openBranchOnRemote, this),
			registerCommand('gitlens.graph.mergeBranchInto', this.mergeBranchInto, this),
			registerCommand('gitlens.graph.rebaseOntoBranch', this.rebase, this),
			registerCommand('gitlens.graph.rebaseOntoUpstream', this.rebaseToRemote, this),
			registerCommand('gitlens.graph.renameBranch', this.renameBranch, this),

			registerCommand('gitlens.graph.switchToAnotherBranch', this.switchToAnother, this),
			registerCommand('gitlens.graph.switchToBranch', this.switchTo, this),

			registerCommand('gitlens.graph.hideLocalBranch', this.hideRef, this),
			registerCommand('gitlens.graph.hideRemoteBranch', this.hideRef, this),
			registerCommand('gitlens.graph.hideRemote', item => this.hideRef(item, { remote: true }), this),
			registerCommand('gitlens.graph.hideRefGroup', item => this.hideRef(item, { group: true }), this),
			registerCommand('gitlens.graph.hideTag', this.hideRef, this),

			registerCommand('gitlens.graph.cherryPick', this.cherryPick, this),
			registerCommand('gitlens.graph.copyRemoteCommitUrl', item => this.openCommitOnRemote(item, true), this),
			registerCommand('gitlens.graph.showInDetailsView', this.openInDetailsView, this),
			registerCommand('gitlens.graph.openCommitOnRemote', this.openCommitOnRemote, this),
			registerCommand('gitlens.graph.rebaseOntoCommit', this.rebase, this),
			registerCommand('gitlens.graph.resetCommit', this.resetCommit, this),
			registerCommand('gitlens.graph.resetToCommit', this.resetToCommit, this),
			registerCommand('gitlens.graph.revert', this.revertCommit, this),
			registerCommand('gitlens.graph.switchToCommit', this.switchTo, this),
			registerCommand('gitlens.graph.undoCommit', this.undoCommit, this),

			registerCommand('gitlens.graph.applyStash', this.applyStash, this),
			registerCommand('gitlens.graph.deleteStash', this.deleteStash, this),

			registerCommand('gitlens.graph.createTag', this.createTag, this),
			registerCommand('gitlens.graph.deleteTag', this.deleteTag, this),
			registerCommand('gitlens.graph.switchToTag', this.switchTo, this),

			registerCommand('gitlens.graph.createWorktree', this.createWorktree, this),

			registerCommand('gitlens.graph.createPullRequest', this.createPullRequest, this),
			registerCommand('gitlens.graph.openPullRequestOnRemote', this.openPullRequestOnRemote, this),
			registerCommand(
				'gitlens.graph.copyRemotePullRequestUrl',
				item => this.openPullRequestOnRemote(item, true),
				this,
			),

			registerCommand('gitlens.graph.compareWithUpstream', this.compareWithUpstream, this),
			registerCommand('gitlens.graph.compareWithHead', this.compareHeadWith, this),
			registerCommand('gitlens.graph.compareWithWorking', this.compareWorkingWith, this),
			registerCommand('gitlens.graph.compareAncestryWithWorking', this.compareAncestryWithWorking, this),

			registerCommand('gitlens.graph.copy', this.copy, this),
			registerCommand('gitlens.graph.copyMessage', this.copyMessage, this),
			registerCommand('gitlens.graph.copySha', this.copySha, this),

			registerCommand('gitlens.graph.addAuthor', this.addAuthor, this),

			registerCommand('gitlens.graph.columnAuthorOn', () => this.toggleColumn('author', true)),
			registerCommand('gitlens.graph.columnAuthorOff', () => this.toggleColumn('author', false)),
			registerCommand('gitlens.graph.columnDateTimeOn', () => this.toggleColumn('datetime', true)),
			registerCommand('gitlens.graph.columnDateTimeOff', () => this.toggleColumn('datetime', false)),
			registerCommand('gitlens.graph.columnShaOn', () => this.toggleColumn('sha', true)),
			registerCommand('gitlens.graph.columnShaOff', () => this.toggleColumn('sha', false)),
		];
	}

	protected override onInitializing(): Disposable[] | undefined {
		this._theme = window.activeColorTheme;
		return [
			this.container.subscription.onDidChange(this.onSubscriptionChanged, this),
			window.onDidChangeActiveColorTheme(this.onThemeChanged, this),
			{ dispose: () => void this._repositoryEventsDisposable?.dispose() },
		];
	}

	protected override onReady(): void {
		this.sendPendingIpcNotifications();
	}

	protected override onMessageReceived(e: IpcMessage) {
		switch (e.method) {
			case DismissBannerCommandType.method:
				onIpc(DismissBannerCommandType, e, params => this.dismissBanner(params));
				break;
			case EnsureRowCommandType.method:
				onIpc(EnsureRowCommandType, e, params => this.onEnsureRow(params, e.completionId));
				break;
			case GetMissingAvatarsCommandType.method:
				onIpc(GetMissingAvatarsCommandType, e, params => this.onGetMissingAvatars(params));
				break;
			case GetMissingRefsMetadataCommandType.method:
				onIpc(GetMissingRefsMetadataCommandType, e, params => this.onGetMissingRefMetadata(params));
				break;
			case GetMoreRowsCommandType.method:
				onIpc(GetMoreRowsCommandType, e, params => this.onGetMoreRows(params));
				break;
			case SearchCommandType.method:
				onIpc(SearchCommandType, e, params => this.onSearch(params, e.completionId));
				break;
			case SearchOpenInViewCommandType.method:
				onIpc(SearchOpenInViewCommandType, e, params => this.onSearchOpenInView(params));
				break;
			case UpdateColumnCommandType.method:
				onIpc(UpdateColumnCommandType, e, params => this.onColumnChanged(params));
				break;
			case UpdateRefsVisibilityCommandType.method:
				onIpc(UpdateRefsVisibilityCommandType, e, params => this.onRefsVisibilityChanged(params));
				break;
			case DoubleClickedRefCommandType.method:
				onIpc(DoubleClickedRefCommandType, e, params => this.onDoubleClickRef(params));
				break;
			case UpdateSelectedRepositoryCommandType.method:
				onIpc(UpdateSelectedRepositoryCommandType, e, params => this.onSelectedRepositoryChanged(params));
				break;
			case UpdateSelectionCommandType.method:
				onIpc(UpdateSelectionCommandType, e, this.onSelectionChanged.bind(this));
				break;
		}
	}

	protected override onFocusChanged(focused: boolean): void {
		if (focused) {
			// If we are becoming focused, delay it a bit to give the UI time to update
			setTimeout(() => void setContext(ContextKeys.GraphPageFocused, focused), 0);

			if (this.selection != null) {
				void GitActions.Commit.showDetailsView(this.selection[0], {
					pin: true,
					preserveFocus: true,
					preserveVisibility: this._showDetailsView === false,
				});
			}

			return;
		}

		void setContext(ContextKeys.GraphPageFocused, focused);
	}

	protected override onVisibilityChanged(visible: boolean): void {
		if (visible && this.repository != null && this.repository.etag !== this._etagRepository) {
			this.updateState(true);
			return;
		}

		if (this.isReady && visible) {
			this.sendPendingIpcNotifications();
		}
	}

	private onConfigurationChanged(e: ConfigurationChangeEvent) {
		if (configuration.changed(e, 'graph.showDetailsView')) {
			this._showDetailsView = configuration.get('graph.showDetailsView');
		}

		if (configuration.changed(e, 'graph.statusBar.enabled') || configuration.changed(e, 'plusFeatures.enabled')) {
			this.updateStatusBar();
		}

		// If we don't have an open webview ignore the rest
		if (this._panel == null) return;

		if (configuration.changed(e, 'graph.commitOrdering')) {
			this.updateState();

			return;
		}

		if (
			configuration.changed(e, 'defaultDateFormat') ||
			configuration.changed(e, 'defaultDateStyle') ||
			configuration.changed(e, 'advanced.abbreviatedShaLength') ||
			configuration.changed(e, 'graph.avatars') ||
			configuration.changed(e, 'graph.dateFormat') ||
			configuration.changed(e, 'graph.dateStyle') ||
			configuration.changed(e, 'graph.highlightRowsOnRefHover') ||
			configuration.changed(e, 'graph.showGhostRefsOnRowHover') ||
			configuration.changed(e, 'graph.showRemoteNames')
		) {
			void this.notifyDidChangeConfiguration();
		}
	}

	private onRepositoryChanged(e: RepositoryChangeEvent) {
		if (
			!e.changed(
				RepositoryChange.Config,
				RepositoryChange.Heads,
				// RepositoryChange.Index,
				RepositoryChange.Remotes,
				// RepositoryChange.RemoteProviders,
				RepositoryChange.Stash,
				RepositoryChange.Status,
				RepositoryChange.Tags,
				RepositoryChange.Unknown,
				RepositoryChangeComparisonMode.Any,
			)
		) {
			this._etagRepository = e.repository.etag;
			return;
		}

		this.updateState();
	}

	private onRepositoryFileSystemChanged(e: RepositoryFileSystemChangeEvent) {
		if (e.repository?.path !== this.repository?.path) return;
		void this.notifyDidChangeWorkingTree();
	}

	private onSubscriptionChanged(e: SubscriptionChangeEvent) {
		if (e.etag === this._etagSubscription) return;

		this._etagSubscription = e.etag;
		void this.notifyDidChangeSubscription();
		this.updateStatusBar();
	}

	private onThemeChanged(theme: ColorTheme) {
		if (this._theme != null) {
			if (
				(isDarkTheme(theme) && isDarkTheme(this._theme)) ||
				(isLightTheme(theme) && isLightTheme(this._theme))
			) {
				return;
			}
		}

		this._theme = theme;
		this.updateState();
	}

	private dismissBanner(e: DismissBannerParams) {
		if (e.key === 'preview') {
			this.previewBanner = false;
		} else if (e.key === 'trial') {
			this.trialBanner = false;
		}

		let banners = this.container.storage.getWorkspace('graph:banners:dismissed');
		banners = updateRecordValue(banners, e.key, true);
		void this.container.storage.storeWorkspace('graph:banners:dismissed', banners);
	}

	private onColumnChanged(e: UpdateColumnParams) {
		this.updateColumn(e.name, e.config);
	}

	private onRefsVisibilityChanged(e: UpdateRefsVisibilityParams) {
		this.updateHiddenRefs(e.refs, e.visible);
	}

	private onDoubleClickRef(e: DoubleClickedRefParams) {
		if (e.ref.context) {
			const item = typeof e.ref.context === 'string' ? JSON.parse(e.ref.context) : e.ref.context;
			if (!('webview' in item)) {
				item.webview = this.id;
			}
			if (isGraphItemRefContext(item)) {
				const { ref } = item.webviewItemValue;
				if (e.ref.refType === 'head' && e.ref.isCurrentHead) {
					return GitActions.switchTo(ref.repoPath);
				}

				// Override the default confirmation if the setting is unset
				return GitActions.switchTo(
					ref.repoPath,
					ref,
					configuration.isUnset('gitCommands.skipConfirmations') ? true : undefined,
				);
			}
		}

		return Promise.resolve();
	}

	@debug()
	private async onEnsureRow(e: EnsureRowParams, completionId?: string) {
		if (this._graph == null) return;

		let id: string | undefined;
		if (!this._graph.skippedIds?.has(e.id)) {
			if (this._graph.ids.has(e.id)) {
				id = e.id;
			} else {
				await this.updateGraphWithMoreRows(this._graph, e.id, this._search);
				void this.notifyDidChangeRows();
				if (this._graph.ids.has(e.id)) {
					id = e.id;
				}
			}
		}

		void this.notify(DidEnsureRowNotificationType, { id: id }, completionId);
	}

	private async onGetMissingAvatars(e: GetMissingAvatarsParams) {
		if (this._graph == null) return;

		const repoPath = this._graph.repoPath;

		async function getAvatar(this: GraphWebview, email: string, id: string) {
			const uri = await getAvatarUri(email, { ref: id, repoPath: repoPath });
			this._graph!.avatars.set(email, uri.toString(true));
		}

		const promises: Promise<void>[] = [];

		for (const [email, id] of Object.entries(e.emails)) {
			if (this._graph.avatars.has(email)) continue;

			promises.push(getAvatar.call(this, email, id));
		}

		if (promises.length) {
			await Promise.allSettled(promises);
			this.updateAvatars();
		}
	}

	private async onGetMissingRefMetadata(e: GetMissingRefsMetadataParams) {
		if (this._graph == null || this._refsMetadata === null || !getContext(ContextKeys.HasConnectedRemotes)) return;

		const repoPath = this._graph.repoPath;

		async function getRefMetadata(this: GraphWebview, id: string, type: GraphMissingRefsMetadataType) {
			if (this._refsMetadata == null) {
				this._refsMetadata = new Map();
			}

			const metadata = { ...this._refsMetadata.get(id) };
			if (type !== 'pullRequests') {
				(metadata as any)[type] = null;
				this._refsMetadata.set(id, metadata);
				return;
			}

			const branch = (await this.container.git.getBranches(repoPath, { filter: b => b.id === id && b.remote }))
				?.values?.[0];
			const pr = await branch?.getAssociatedPullRequest();
			if (pr == null) {
				if (metadata.pullRequests === undefined || metadata.pullRequests?.length === 0) {
					metadata.pullRequests = null;
				}
				this._refsMetadata.set(id, metadata);
				return;
			}

			const prMetadata: GraphPullRequestMetadata = {
				// TODO@eamodio: This is iffy, but works right now since `github` and `gitlab` are the only values possible currently
				hostingServiceType: pr.provider.id as GraphHostingServiceType,
				id: Number.parseInt(pr.id) || 0,
				title: pr.title,
				author: pr.author.name,
				date: (pr.mergedDate ?? pr.closedDate ?? pr.date)?.getTime(),
				state: pr.state,
				url: pr.url,
				context: serializeWebviewItemContext<GraphItemContext>({
					webviewItem: 'gitlens:graph:pullrequest',
					webviewItemValue: {
						type: 'pullrequest',
						id: pr.id,
						url: pr.url,
					},
				}),
			};

			metadata.pullRequests = [prMetadata];
			this._refsMetadata.set(id, metadata);
		}

		const promises: Promise<void>[] = [];

		for (const [id, missingTypes] of Object.entries(e.metadata)) {
			for (const missingType of missingTypes) {
				promises.push(getRefMetadata.call(this, id, missingType));
			}
		}

		if (promises.length) {
			await Promise.allSettled(promises);
		}
		this.updateRefsMetadata();
	}

	@gate()
	@debug()
	private async onGetMoreRows(e: GetMoreRowsParams, sendSelectedRows: boolean = false) {
		if (this._graph?.paging == null) return;
		if (this._graph?.more == null || this._repository?.etag !== this._etagRepository) {
			this.updateState(true);

			return;
		}

		await this.updateGraphWithMoreRows(this._graph, e.id, this._search);
		void this.notifyDidChangeRows(sendSelectedRows);
	}

	@debug()
	private async onSearch(e: SearchParams, completionId?: string) {
		if (e.search == null) {
			this.resetSearchState();

			// This shouldn't happen, but just in case
			if (completionId != null) {
				debugger;
			}
			return;
		}

		let search: GitSearch | undefined = this._search;

		if (e.more && search?.more != null && search.comparisonKey === getSearchQueryComparisonKey(e.search)) {
			search = await search.more(e.limit ?? configuration.get('graph.searchItemLimit') ?? 100);
			if (search != null) {
				this._search = search;
				void (await this.ensureSearchStartsInRange(this._graph!, search));

				void this.notify(
					DidSearchNotificationType,
					{
						results:
							search.results.size > 0
								? {
										ids: Object.fromEntries(search.results),
										count: search.results.size,
										paging: { hasMore: search.paging?.hasMore ?? false },
								  }
								: undefined,
					},
					completionId,
				);
			}

			return;
		}

		if (search == null || search.comparisonKey !== getSearchQueryComparisonKey(e.search)) {
			if (this._repository == null) return;

			if (this._repository.etag !== this._etagRepository) {
				this.updateState(true);
			}

			if (this._searchCancellation != null) {
				this._searchCancellation.cancel();
				this._searchCancellation.dispose();
			}

			const cancellation = new CancellationTokenSource();
			this._searchCancellation = cancellation;

			try {
				search = await this._repository.searchCommits(e.search, {
					limit: configuration.get('graph.searchItemLimit') ?? 100,
					ordering: configuration.get('graph.commitOrdering'),
					cancellation: cancellation.token,
				});
			} catch (ex) {
				this._search = undefined;

				void this.notify(
					DidSearchNotificationType,
					{
						results: {
							error: ex instanceof GitSearchError ? 'Invalid search pattern' : 'Unexpected error',
						},
					},
					completionId,
				);
				return;
			}

			if (cancellation.token.isCancellationRequested) {
				if (completionId != null) {
					void this.notify(DidSearchNotificationType, { results: undefined }, completionId);
				}
				return;
			}

			this._search = search;
		} else {
			search = this._search!;
		}

		const firstResult = await this.ensureSearchStartsInRange(this._graph!, search);

		let sendSelectedRows = false;
		if (firstResult != null) {
			sendSelectedRows = true;
			this.setSelectedRows(firstResult);
		}

		void this.notify(
			DidSearchNotificationType,
			{
				results:
					search.results.size === 0
						? { count: 0 }
						: {
								ids: Object.fromEntries(search.results),
								count: search.results.size,
								paging: { hasMore: search.paging?.hasMore ?? false },
						  },
				selectedRows: sendSelectedRows ? this._selectedRows : undefined,
			},
			completionId,
		);
	}

	private onSearchOpenInView(e: SearchOpenInViewParams) {
		if (this.repository == null) return;

		void this.container.searchAndCompareView.search(this.repository.path, e.search, {
			label: { label: `for ${e.search.query}` },
			reveal: {
				select: true,
				focus: false,
				expand: true,
			},
		});
	}

	private onSelectedRepositoryChanged(e: UpdateSelectedRepositoryParams) {
		this.repository = this.container.git.getRepository(e.path);
	}

	private _fireSelectionChangedDebounced: Deferrable<GraphWebview['fireSelectionChanged']> | undefined = undefined;

	private onSelectionChanged(e: UpdateSelectionParams) {
		const item = e.selection[0];
		this.setSelectedRows(item?.id);

		if (this._fireSelectionChangedDebounced == null) {
			this._fireSelectionChangedDebounced = debounce(this.fireSelectionChanged.bind(this), 250);
		}

		void this._fireSelectionChangedDebounced(item?.id, item?.type);
	}

	private async fireSelectionChanged(id: string | undefined, type: GitGraphRowType | undefined) {
		let commits: GitCommit[] | undefined;
		if (id != null) {
			let commit;
			if (type === GitGraphRowType.Stash) {
				const stash = await this.repository?.getStash();
				commit = stash?.commits.get(id);
			} else if (type === GitGraphRowType.Working) {
				commit = await this.repository?.getCommit(GitRevision.uncommitted);
			} else {
				commit = await this.repository?.getCommit(id);
			}
			if (commit != null) {
				commits = [commit];
			}
		}

		this._selection = commits;
		this._onDidChangeSelection.fire({ selection: commits ?? [] });

		if (commits == null) return;

		void GitActions.Commit.showDetailsView(commits[0], {
			pin: true,
			preserveFocus: true,
			preserveVisibility: this._firstSelection
				? this._showDetailsView === false
				: this._showDetailsView !== 'selection',
		});
		this._firstSelection = false;
	}

	private _notifyDidChangeStateDebounced: Deferrable<GraphWebview['notifyDidChangeState']> | undefined = undefined;

	@debug()
	private updateState(immediate: boolean = false) {
		this._pendingIpcNotifications.clear();

		if (immediate) {
			void this.notifyDidChangeState();
			return;
		}

		if (this._notifyDidChangeStateDebounced == null) {
			this._notifyDidChangeStateDebounced = debounce(this.notifyDidChangeState.bind(this), 500);
		}

		void this._notifyDidChangeStateDebounced();
	}

	private _notifyDidChangeAvatarsDebounced: Deferrable<GraphWebview['notifyDidChangeAvatars']> | undefined =
		undefined;

	@debug()
	private updateAvatars(immediate: boolean = false) {
		if (immediate) {
			void this.notifyDidChangeAvatars();
			return;
		}

		if (this._notifyDidChangeAvatarsDebounced == null) {
			this._notifyDidChangeAvatarsDebounced = debounce(this.notifyDidChangeAvatars.bind(this), 100);
		}

		void this._notifyDidChangeAvatarsDebounced();
	}

	@debug()
	private async notifyDidChangeAvatars() {
		if (this._graph == null) return;

		const data = this._graph;
		return this.notify(DidChangeAvatarsNotificationType, {
			avatars: Object.fromEntries(data.avatars),
		});
	}

	private _notifyDidChangeRefsMetadataDebounced: Deferrable<GraphWebview['notifyDidChangeRefsMetadata']> | undefined =
		undefined;

	@debug()
	private updateRefsMetadata(immediate: boolean = false) {
		if (immediate) {
			void this.notifyDidChangeRefsMetadata();
			return;
		}

		if (this._notifyDidChangeRefsMetadataDebounced == null) {
			this._notifyDidChangeRefsMetadataDebounced = debounce(this.notifyDidChangeRefsMetadata.bind(this), 100);
		}

		void this._notifyDidChangeRefsMetadataDebounced();
	}

	@debug()
	private async notifyDidChangeRefsMetadata() {
		return this.notify(DidChangeRefsMetadataNotificationType, {
			metadata: this._refsMetadata != null ? Object.fromEntries(this._refsMetadata) : this._refsMetadata,
		});
	}

	@debug()
	private async notifyDidChangeColumns() {
		if (!this.isReady || !this.visible) {
			this.addPendingIpcNotification(DidChangeColumnsNotificationType);
			return false;
		}

		const columns = this.getColumns();
		return this.notify(DidChangeColumnsNotificationType, {
			columns: this.getColumnSettings(columns),
			context: this.getColumnHeaderContext(columns),
		});
	}

	@debug()
	private async notifyDidChangeRefsVisibility() {
		if (!this.isReady || !this.visible) {
			this.addPendingIpcNotification(DidChangeRefsVisibilityNotificationType);
			return false;
		}

		return this.notify(DidChangeRefsVisibilityNotificationType, {
			hiddenRefs: this.getHiddenRefs(this._graph),
		});
	}

	@debug()
	private async notifyDidChangeConfiguration() {
		if (!this.isReady || !this.visible) {
			this.addPendingIpcNotification(DidChangeGraphConfigurationNotificationType);
			return false;
		}

		return this.notify(DidChangeGraphConfigurationNotificationType, {
			config: this.getComponentConfig(),
		});
	}

	@debug()
	private async notifyDidChangeRows(sendSelectedRows: boolean = false, completionId?: string) {
		if (this._graph == null) return;

		const data = this._graph;
		return this.notify(
			DidChangeRowsNotificationType,
			{
				rows: data.rows,
				avatars: Object.fromEntries(data.avatars),
				refsMetadata: this._refsMetadata != null ? Object.fromEntries(this._refsMetadata) : this._refsMetadata,
				selectedRows: sendSelectedRows ? this._selectedRows : undefined,
				paging: {
					startingCursor: data.paging?.startingCursor,
					hasMore: data.paging?.hasMore ?? false,
				},
			},
			completionId,
		);
	}

	@debug()
	private async notifyDidChangeWorkingTree() {
		if (!this.isReady || !this.visible) {
			this.addPendingIpcNotification(DidChangeWorkingTreeNotificationType);
			return false;
		}

		return this.notify(DidChangeWorkingTreeNotificationType, {
			stats: (await this.getWorkingTreeStats()) ?? { added: 0, deleted: 0, modified: 0 },
		});
	}

	@debug()
	private async notifyDidChangeSelection() {
		if (!this.isReady || !this.visible) {
			this.addPendingIpcNotification(DidChangeSelectionNotificationType);
			return false;
		}

		return this.notify(DidChangeSelectionNotificationType, {
			selection: this._selectedRows ?? {},
		});
	}

	@debug()
	private async notifyDidChangeSubscription() {
		if (!this.isReady || !this.visible) {
			this.addPendingIpcNotification(DidChangeSubscriptionNotificationType);
			return false;
		}

		const [access] = await this.getGraphAccess();
		return this.notify(DidChangeSubscriptionNotificationType, {
			subscription: access.subscription.current,
			allowed: access.allowed !== false,
		});
	}

	@debug()
	private async notifyDidChangeState() {
		if (!this.isReady || !this.visible) {
			this.addPendingIpcNotification(DidChangeNotificationType);
			return false;
		}

		return this.notify(DidChangeNotificationType, { state: await this.getState() });
	}

	protected override async notify<T extends IpcNotificationType<any>>(
		type: T,
		params: IpcMessageParams<T>,
		completionId?: string,
	): Promise<boolean> {
		const msg: IpcMessage = {
			id: this.nextIpcId(),
			method: type.method,
			params: params,
			completionId: completionId,
		};
		const success = await this.postMessage(msg);
		if (success) {
			this._pendingIpcNotifications.clear();
		} else {
			this.addPendingIpcNotification(type, msg);
		}
		return success;
	}

	private readonly _ipcNotificationMap = new Map<IpcNotificationType<any>, () => Promise<boolean>>([
		[DidChangeColumnsNotificationType, this.notifyDidChangeColumns],
		[DidChangeGraphConfigurationNotificationType, this.notifyDidChangeConfiguration],
		[DidChangeNotificationType, this.notifyDidChangeState],
		[DidChangeRefsVisibilityNotificationType, this.notifyDidChangeRefsVisibility],
		[DidChangeSelectionNotificationType, this.notifyDidChangeSelection],
		[DidChangeSubscriptionNotificationType, this.notifyDidChangeSubscription],
		[DidChangeWorkingTreeNotificationType, this.notifyDidChangeWorkingTree],
	]);

	private addPendingIpcNotification(type: IpcNotificationType<any>, msg?: IpcMessage) {
		if (type === DidChangeNotificationType) {
			this._pendingIpcNotifications.clear();
		} else if (type.overwriteable) {
			this._pendingIpcNotifications.delete(type);
		}

		let msgOrFn: IpcMessage | (() => Promise<boolean>) | undefined;
		if (msg == null) {
			msgOrFn = this._ipcNotificationMap.get(type)?.bind(this);
			if (msgOrFn == null) {
				debugger;
				return;
			}
		} else {
			msgOrFn = msg;
		}
		this._pendingIpcNotifications.set(type, msgOrFn);
	}

	private sendPendingIpcNotifications() {
		if (this._pendingIpcNotifications.size === 0) return;

		const ipcs = new Map(this._pendingIpcNotifications);
		this._pendingIpcNotifications.clear();
		for (const msgOrFn of ipcs.values()) {
			if (typeof msgOrFn === 'function') {
				void msgOrFn();
			} else {
				void this.postMessage(msgOrFn);
			}
		}
	}

	private async ensureSearchStartsInRange(graph: GitGraph, search: GitSearch) {
		if (search.results.size === 0) return undefined;

		let firstResult: string | undefined;
		for (const id of search.results.keys()) {
			if (graph.ids.has(id)) return id;
			if (graph.skippedIds?.has(id)) continue;

			firstResult = id;
			break;
		}

		if (firstResult == null) return undefined;

		await this.updateGraphWithMoreRows(graph, firstResult);
		void this.notifyDidChangeRows();

		return graph.ids.has(firstResult) ? firstResult : undefined;
	}

	private getColumns(): Record<GraphColumnName, GraphColumnConfig> | undefined {
		return this.container.storage.getWorkspace('graph:columns');
	}

	private getHiddenRefs(graph: GitGraph | undefined): Record<string, GraphHiddenRef> | undefined {
		return this.filterHiddenRefs(this.container.storage.getWorkspace('graph:hiddenRefs'), graph);
	}

	private filterHiddenRefs(
		hiddenRefs: Record<string, StoredGraphHiddenRef> | undefined,
		graph: GitGraph | undefined,
	): GraphHiddenRefs | undefined {
		if (hiddenRefs == null || graph == null) return undefined;

		const useAvatars = configuration.get('graph.avatars', undefined, true);

		const filteredRefs: GraphHiddenRefs = {};

		for (const id in hiddenRefs) {
			if (getRepoPathFromBranchOrTagId(id) === graph.repoPath) {
				const ref: GraphHiddenRef = { ...hiddenRefs[id] };
				if (ref.type === 'remote' && ref.owner) {
					const remote = graph.remotes.get(ref.owner);
					if (remote != null) {
						ref.avatarUrl = (
							(useAvatars ? remote.provider?.avatarUri : undefined) ??
							getRemoteIconUri(this.container, remote, this._panel!.webview.asWebviewUri.bind(this))
						)?.toString(true);
					}
				}
				filteredRefs[id] = ref;
			}
		}

		return filteredRefs;

		// This validation has too much performance impact. So we decided to comment those lines
		// for v13 and have it as tech debt to solve after we launch.
		// See: https://github.com/gitkraken/vscode-gitlens/pull/2211#discussion_r990117432
		// if (this.repository == null) {
		// 	this.repository = this.container.git.getBestRepositoryOrFirst();
		// 	if (this.repository == null) return undefined;
		// }

		// const [hiddenBranches, hiddenTags] = await Promise.all([
		// 	this.repository.getBranches({
		// 		filter: b => !b.current && hiddenRefs[b.id] != undefined,
		// 	}),
		// 	this.repository.getTags({
		// 		filter: t => hiddenRefs[t.id] != undefined,
		// 	}),
		// ]);

		// const filteredHiddenRefsById: GraphHiddenRefs = {};

		// for (const hiddenBranch of hiddenBranches.values) {
		// 	filteredHiddenRefsById[hiddenBranch.id] = hiddenRefs[hiddenBranch.id];
		// }

		// for (const hiddenTag of hiddenTags.values) {
		// 	filteredHiddenRefsById[hiddenTag.id] = hiddenRefs[hiddenTag.id];
		// }

		// return filteredHiddenRefsById;

		// For v13, we return directly the hidden refs without validating them
		return hiddenRefs;
	}

	private getColumnSettings(columns: Record<GraphColumnName, GraphColumnConfig> | undefined): GraphColumnsSettings {
		const columnsSettings: GraphColumnsSettings = {
			...defaultGraphColumnsSettings,
		};
		if (columns != null) {
			for (const [column, columnCfg] of Object.entries(columns) as [GraphColumnName, GraphColumnConfig][]) {
				columnsSettings[column] = {
					...defaultGraphColumnsSettings[column],
					...columnCfg,
				};
			}
		}

		return columnsSettings;
	}

	private getColumnHeaderContext(columns: Record<GraphColumnName, GraphColumnConfig> | undefined): string {
		const hidden: string[] = [];
		if (columns != null) {
			for (const [name, cfg] of Object.entries(columns)) {
				if (cfg.isHidden) {
					hidden.push(name);
				}
			}
		}
		return serializeWebviewItemContext<GraphItemContext>({
			webviewItem: 'gitlens:graph:columns',
			webviewItemValue: hidden.join(','),
		});
	}

	private getComponentConfig(): GraphComponentConfig {
		const config: GraphComponentConfig = {
			avatars: configuration.get('graph.avatars'),
			dateFormat:
				configuration.get('graph.dateFormat') ?? configuration.get('defaultDateFormat') ?? 'short+short',
			dateStyle: configuration.get('graph.dateStyle') ?? configuration.get('defaultDateStyle'),
			enableMultiSelection: false,
			highlightRowsOnRefHover: configuration.get('graph.highlightRowsOnRefHover'),
			showGhostRefsOnRowHover: configuration.get('graph.showGhostRefsOnRowHover'),
			showRemoteNamesOnRefs: configuration.get('graph.showRemoteNames'),
			idLength: configuration.get('advanced.abbreviatedShaLength'),
		};
		return config;
	}

	private async getGraphAccess() {
		let access = await this.container.git.access(PlusFeatures.Graph, this.repository?.path);
		this._etagSubscription = this.container.subscription.etag;

		// If we don't have access to GitLens+, but the preview trial hasn't been started, auto-start it
		if (access.allowed === false && access.subscription.current.previewTrial == null) {
			await this.container.subscription.startPreviewTrial(true);
			access = await this.container.git.access(PlusFeatures.Graph, this.repository?.path);
		}

		let visibility = access?.visibility;
		if (visibility == null && this.repository != null) {
			visibility = await this.container.git.visibility(this.repository?.path);
		}

		return [access, visibility] as const;
	}

	private async getWorkingTreeStats(): Promise<GraphWorkingTreeStats | undefined> {
		if (this.container.git.repositoryCount === 0) return undefined;

		if (this.repository == null) {
			this.repository = this.container.git.getBestRepositoryOrFirst();
			if (this.repository == null) return undefined;
		}

		const status = await this.container.git.getStatusForRepo(this.repository.path);
		const workingTreeStatus = status?.getDiffStatus();
		return {
			added: workingTreeStatus?.added ?? 0,
			deleted: workingTreeStatus?.deleted ?? 0,
			modified: workingTreeStatus?.changed ?? 0,
		};
	}

	private async getState(deferRows?: boolean): Promise<State> {
		if (this.container.git.repositoryCount === 0) return { allowed: true, repositories: [] };

		if (this.previewBanner == null || this.trialBanner == null) {
			const banners = this.container.storage.getWorkspace('graph:banners:dismissed');
			if (this.previewBanner == null) {
				this.previewBanner = !banners?.['preview'];
			}
			if (this.trialBanner == null) {
				this.trialBanner = !banners?.['trial'];
			}
		}

		if (this.repository == null) {
			this.repository = this.container.git.getBestRepositoryOrFirst();
			if (this.repository == null) return { allowed: true, repositories: [] };
		}

		this._etagRepository = this.repository?.etag;
		this.title = `${this.originalTitle}: ${this.repository.formattedName}`;

		const { defaultItemLimit } = configuration.get('graph');

		// If we have a set of data refresh to the same set
		const limit = Math.max(defaultItemLimit, this._graph?.ids.size ?? defaultItemLimit);

		const dataPromise = this.container.git.getCommitsForGraph(
			this.repository.path,
			this._panel!.webview.asWebviewUri.bind(this._panel!.webview),
			{ limit: limit, ref: this._selectedId ?? 'HEAD' },
		);

		// Check for GitLens+ access and working tree stats
		const [accessResult, workingStatsResult] = await Promise.allSettled([
			this.getGraphAccess(),
			this.getWorkingTreeStats(),
		]);
		const [access, visibility] = getSettledValue(accessResult) ?? [];

		let data;
		if (deferRows) {
			queueMicrotask(async () => {
				const data = await dataPromise;
				this.setGraph(data);
				this.setSelectedRows(data.id);

				void this.notifyDidChangeRefsVisibility();
				void this.notifyDidChangeRows(true);
			});
		} else {
			data = await dataPromise;
			this.setGraph(data);
			this.setSelectedRows(data.id);
		}

		const columns = this.getColumns();

		return {
			previewBanner: this.previewBanner,
			trialBanner: this.trialBanner,
			repositories: formatRepositories(this.container.git.openRepositories),
			selectedRepository: this.repository.path,
			selectedRepositoryVisibility: visibility,
			selectedRows: this._selectedRows,
			subscription: access?.subscription.current,
			allowed: (access?.allowed ?? false) !== false,
			avatars: data != null ? Object.fromEntries(data.avatars) : undefined,
			refsMetadata: this.resetRefsMetadata(),
			loading: deferRows,
			rows: data?.rows,
			paging:
				data != null
					? {
							startingCursor: data.paging?.startingCursor,
							hasMore: data.paging?.hasMore ?? false,
					  }
					: undefined,
			columns: this.getColumnSettings(columns),
			config: this.getComponentConfig(),
			context: {
				header: this.getColumnHeaderContext(columns),
			},
			hiddenRefs: data != null ? this.getHiddenRefs(data) : undefined,
			nonce: this.cspNonce,
			workingTreeStats: getSettledValue(workingStatsResult) ?? { added: 0, deleted: 0, modified: 0 },
		};
	}

	private updateColumn(name: GraphColumnName, cfg: GraphColumnConfig) {
		let columns = this.container.storage.getWorkspace('graph:columns');
		columns = updateRecordValue(columns, name, cfg);
		void this.container.storage.storeWorkspace('graph:columns', columns);
		void this.notifyDidChangeColumns();
	}

	private updateHiddenRefs(refs: GraphHiddenRef[], visible: boolean) {
		let storedHiddenRefs = this.container.storage.getWorkspace('graph:hiddenRefs');
		for (const ref of refs) {
			storedHiddenRefs = updateRecordValue(
				storedHiddenRefs,
				ref.id,
				visible ? undefined : { id: ref.id, type: ref.type, name: ref.name, owner: ref.owner },
			);
		}

		void this.container.storage.storeWorkspace('graph:hiddenRefs', storedHiddenRefs);
		void this.notifyDidChangeRefsVisibility();
	}

	private resetRefsMetadata(): null | undefined {
		this._refsMetadata = getContext(ContextKeys.HasConnectedRemotes) ? undefined : null;
		return this._refsMetadata;
	}

	private resetRepositoryState() {
		this.setGraph(undefined);
		this.setSelectedRows(undefined);
	}

	private resetSearchState() {
		this._search = undefined;
		this._searchCancellation?.dispose();
		this._searchCancellation = undefined;
	}

	private setSelectedRows(id: string | undefined) {
		if (this._selectedId === id) return;

		this._selectedId = id;
		this._selectedRows = id != null ? { [id]: true } : undefined;
	}

	private setGraph(graph: GitGraph | undefined) {
		this._graph = graph;
		if (graph == null) {
			this.resetRefsMetadata();
			this.resetSearchState();
		}
	}

	private async updateGraphWithMoreRows(graph: GitGraph, id: string | undefined, search?: GitSearch) {
		const { defaultItemLimit, pageItemLimit } = configuration.get('graph');
		const updatedGraph = await graph.more?.(pageItemLimit ?? defaultItemLimit, id);
		if (updatedGraph != null) {
			this.setGraph(updatedGraph);

			if (search?.paging?.hasMore) {
				const lastId = last(search.results)?.[0];
				if (lastId != null && (updatedGraph.ids.has(lastId) || updatedGraph.skippedIds?.has(lastId))) {
					queueMicrotask(() => void this.onSearch({ search: search.query, more: true }));
				}
			}
		} else {
			debugger;
		}
	}

	private updateStatusBar() {
		const enabled =
			configuration.get('graph.statusBar.enabled') && getContext(ContextKeys.Enabled) && arePlusFeaturesEnabled();
		if (enabled) {
			if (this._statusBarItem == null) {
				this._statusBarItem = window.createStatusBarItem('gitlens.graph', StatusBarAlignment.Left, 10000 - 3);
				this._statusBarItem.name = 'GitLens Commit Graph';
				this._statusBarItem.command = Commands.ShowGraphPage;
				this._statusBarItem.text = '$(gitlens-graph)';
				this._statusBarItem.tooltip = new MarkdownString('Visualize commits on the all-new Commit Graph ✨');
				this._statusBarItem.accessibilityInformation = {
					label: `Show the GitLens Commit Graph`,
				};
			}
			this._statusBarItem.show();
		} else {
			this._statusBarItem?.dispose();
			this._statusBarItem = undefined;
		}
	}

	@debug()
	private createBranch(item: GraphItemContext) {
		if (isGraphItemRefContext(item)) {
			const { ref } = item.webviewItemValue;
			return GitActions.Branch.create(ref.repoPath, ref);
		}

		return Promise.resolve();
	}

	@debug()
	private deleteBranch(item: GraphItemContext) {
		if (isGraphItemRefContext(item, 'branch')) {
			const { ref } = item.webviewItemValue;
			return GitActions.Branch.remove(ref.repoPath, ref);
		}

		return Promise.resolve();
	}

	@debug()
	private mergeBranchInto(item: GraphItemContext) {
		if (isGraphItemRefContext(item, 'branch')) {
			const { ref } = item.webviewItemValue;
			return GitActions.merge(ref.repoPath, ref);
		}

		return Promise.resolve();
	}

	@debug()
	private openBranchOnRemote(item: GraphItemContext, clipboard?: boolean) {
		if (isGraphItemRefContext(item, 'branch')) {
			const { ref } = item.webviewItemValue;
			return executeCommand<OpenBranchOnRemoteCommandArgs>(Commands.OpenBranchOnRemote, {
				branch: ref.name,
				remote: ref.upstream?.name,
				clipboard: clipboard,
			});
		}

		return Promise.resolve();
	}

	@debug()
	private rebase(item: GraphItemContext) {
		if (isGraphItemRefContext(item)) {
			const { ref } = item.webviewItemValue;
			return GitActions.rebase(ref.repoPath, ref);
		}

		return Promise.resolve();
	}

	@debug()
	private rebaseToRemote(item: GraphItemContext) {
		if (isGraphItemRefContext(item, 'branch')) {
			const { ref } = item.webviewItemValue;
			if (ref.upstream != null) {
				return GitActions.rebase(
					ref.repoPath,
					GitReference.create(ref.upstream.name, ref.repoPath, {
						refType: 'branch',
						name: ref.upstream.name,
						remote: true,
					}),
				);
			}
		}

		return Promise.resolve();
	}

	@debug()
	private renameBranch(item: GraphItemContext) {
		if (isGraphItemRefContext(item, 'branch')) {
			const { ref } = item.webviewItemValue;
			return GitActions.Branch.rename(ref.repoPath, ref);
		}

		return Promise.resolve();
	}

	@debug()
	private cherryPick(item: GraphItemContext) {
		if (isGraphItemRefContext(item, 'revision')) {
			const { ref } = item.webviewItemValue;
			return GitActions.cherryPick(ref.repoPath, ref);
		}

		return Promise.resolve();
	}

	@debug()
	private async copy(item: GraphItemContext) {
		if (isGraphItemTypedContext(item, 'contributor')) {
			const { name, email } = item.webviewItemValue;
			await env.clipboard.writeText(`${name}${email ? ` <${email}>` : ''}`);
		}

		return Promise.resolve();
	}

	@debug()
	private copyMessage(item: GraphItemContext) {
		if (isGraphItemRefContext(item)) {
			const { ref } = item.webviewItemValue;
			return executeCommand<CopyMessageToClipboardCommandArgs>(Commands.CopyMessageToClipboard, {
				repoPath: ref.repoPath,
				sha: ref.ref,
				message: 'message' in ref ? ref.message : undefined,
			});
		}

		return Promise.resolve();
	}

	@debug()
	private async copySha(item: GraphItemContext) {
		if (isGraphItemRefContext(item)) {
			const { ref } = item.webviewItemValue;

			let sha = ref.ref;
			if (!GitRevision.isSha(sha)) {
				sha = await this.container.git.resolveReference(ref.repoPath, sha, undefined, { force: true });
			}

			return executeCommand<CopyShaToClipboardCommandArgs>(Commands.CopyShaToClipboard, {
				sha: sha,
			});
		}

		return Promise.resolve();
	}

	@debug()
	private openInDetailsView(item: GraphItemContext) {
		if (isGraphItemRefContext(item, 'revision')) {
			const { ref } = item.webviewItemValue;
			return executeCommand<ShowCommitsInViewCommandArgs>(Commands.ShowInDetailsView, {
				repoPath: ref.repoPath,
				refs: [ref.ref],
			});
		}

		return Promise.resolve();
	}

	@debug()
	private openCommitOnRemote(item: GraphItemContext, clipboard?: boolean) {
		if (isGraphItemRefContext(item, 'revision')) {
			const { ref } = item.webviewItemValue;
			return executeCommand<OpenCommitOnRemoteCommandArgs>(Commands.OpenCommitOnRemote, {
				sha: ref.ref,
				clipboard: clipboard,
			});
		}

		return Promise.resolve();
	}

	@debug()
	private resetCommit(item: GraphItemContext) {
		if (isGraphItemRefContext(item, 'revision')) {
			const { ref } = item.webviewItemValue;
			return GitActions.reset(
				ref.repoPath,
				GitReference.create(`${ref.ref}^`, ref.repoPath, {
					refType: 'revision',
					name: `${ref.name}^`,
					message: ref.message,
				}),
			);
		}

		return Promise.resolve();
	}

	@debug()
	private resetToCommit(item: GraphItemContext) {
		if (isGraphItemRefContext(item, 'revision')) {
			const { ref } = item.webviewItemValue;
			return GitActions.reset(ref.repoPath, ref);
		}

		return Promise.resolve();
	}

	@debug()
	private revertCommit(item: GraphItemContext) {
		if (isGraphItemRefContext(item, 'revision')) {
			const { ref } = item.webviewItemValue;
			return GitActions.revert(ref.repoPath, ref);
		}

		return Promise.resolve();
	}

	@debug()
	private switchTo(item: GraphItemContext) {
		if (isGraphItemRefContext(item)) {
			const { ref } = item.webviewItemValue;
			return GitActions.switchTo(ref.repoPath, ref);
		}

		return Promise.resolve();
	}

	@debug()
	private hideRef(item: GraphItemContext, options?: { group?: boolean; remote?: boolean }) {
		let refs;
		if (options?.group && isGraphItemRefGroupContext(item)) {
			({ refs } = item.webviewItemGroupValue);
		} else if (!options?.group && isGraphItemRefContext(item)) {
			const { ref } = item.webviewItemValue;
			if (ref.id != null) {
				refs = [ref];
			}
		}

		if (refs != null) {
			this.updateHiddenRefs(
				refs.map(r => {
					const remoteBranch = r.refType === 'branch' && r.remote;
					return {
						id: r.id!,
						name: remoteBranch ? (options?.remote ? '*' : getBranchNameWithoutRemote(r.name)) : r.name,
						owner: remoteBranch ? getRemoteNameFromBranchName(r.name) : undefined,
						type: r.refType === 'branch' ? (r.remote ? 'remote' : 'head') : 'tag',
					};
				}),
				false,
			);
		}

		return Promise.resolve();
	}

	@debug()
	private switchToAnother(item: GraphItemContext) {
		if (isGraphItemRefContext(item)) {
			const { ref } = item.webviewItemValue;
			return GitActions.switchTo(ref.repoPath);
		}

		return Promise.resolve();
	}

	@debug()
	private async undoCommit(item: GraphItemContext) {
		if (isGraphItemRefContext(item, 'revision')) {
			const { ref } = item.webviewItemValue;
			const repo = await this.container.git.getOrOpenScmRepository(ref.repoPath);
			const commit = await repo?.getCommit('HEAD');

			if (commit?.hash !== ref.ref) {
				void window.showWarningMessage(
					`Commit ${GitReference.toString(ref, {
						capitalize: true,
						icon: false,
					})} cannot be undone, because it is no longer the most recent commit.`,
				);

				return;
			}

			return void executeCoreGitCommand(CoreGitCommands.UndoCommit, ref.repoPath);
		}

		return Promise.resolve();
	}

	@debug()
	private applyStash(item: GraphItemContext) {
		if (isGraphItemRefContext(item, 'stash')) {
			const { ref } = item.webviewItemValue;
			return GitActions.Stash.apply(ref.repoPath, ref);
		}

		return Promise.resolve();
	}

	@debug()
	private deleteStash(item: GraphItemContext) {
		if (isGraphItemRefContext(item, 'stash')) {
			const { ref } = item.webviewItemValue;
			return GitActions.Stash.drop(ref.repoPath, ref);
		}

		return Promise.resolve();
	}

	@debug()
	private async createTag(item: GraphItemContext) {
		if (isGraphItemRefContext(item)) {
			const { ref } = item.webviewItemValue;
			return GitActions.Tag.create(ref.repoPath, ref);
		}

		return Promise.resolve();
	}

	@debug()
	private deleteTag(item: GraphItemContext) {
		if (isGraphItemRefContext(item, 'tag')) {
			const { ref } = item.webviewItemValue;
			return GitActions.Tag.remove(ref.repoPath, ref);
		}

		return Promise.resolve();
	}

	@debug()
	private async createWorktree(item: GraphItemContext) {
		if (isGraphItemRefContext(item)) {
			const { ref } = item.webviewItemValue;
			return GitActions.Worktree.create(ref.repoPath, undefined, ref);
		}

		return Promise.resolve();
	}

	@debug()
	private async createPullRequest(item: GraphItemContext) {
		if (isGraphItemRefContext(item, 'branch')) {
			const { ref } = item.webviewItemValue;

			const repo = this.container.git.getRepository(ref.repoPath);
			const branch = await repo?.getBranch(ref.name);
			const remote = await branch?.getRemote();

			return executeActionCommand<CreatePullRequestActionContext>('createPullRequest', {
				repoPath: ref.repoPath,
				remote:
					remote != null
						? {
								name: remote.name,
								provider:
									remote.provider != null
										? {
												id: remote.provider.id,
												name: remote.provider.name,
												domain: remote.provider.domain,
										  }
										: undefined,
								url: remote.url,
						  }
						: undefined,
				branch: {
					name: ref.name,
					upstream: ref.upstream?.name,
					isRemote: ref.remote,
				},
			});
		}

		return Promise.resolve();
	}

	@debug()
	private openPullRequestOnRemote(item: GraphItemContext, clipboard?: boolean) {
		if (
			isGraphItemContext(item) &&
			typeof item.webviewItemValue === 'object' &&
			item.webviewItemValue.type === 'pullrequest'
		) {
			const { url } = item.webviewItemValue;
			return executeCommand<OpenPullRequestOnRemoteCommandArgs>(Commands.OpenPullRequestOnRemote, {
				pr: { url: url },
				clipboard: clipboard,
			});
		}

		return Promise.resolve();
	}

	@debug()
	private async compareAncestryWithWorking(item: GraphItemContext) {
		if (isGraphItemRefContext(item)) {
			const { ref } = item.webviewItemValue;

			const branch = await this.container.git.getBranch(ref.repoPath);
			if (branch == null) return undefined;

			const commonAncestor = await this.container.git.getMergeBase(ref.repoPath, branch.ref, ref.ref);
			if (commonAncestor == null) return undefined;

			return this.container.searchAndCompareView.compare(
				ref.repoPath,
				{ ref: commonAncestor, label: `ancestry with ${ref.ref} (${GitRevision.shorten(commonAncestor)})` },
				'',
			);
		}

		return Promise.resolve();
	}

	@debug()
	private compareHeadWith(item: GraphItemContext) {
		if (isGraphItemRefContext(item)) {
			const { ref } = item.webviewItemValue;
			return this.container.searchAndCompareView.compare(ref.repoPath, 'HEAD', ref.ref);
		}

		return Promise.resolve();
	}

	@debug()
	private compareWithUpstream(item: GraphItemContext) {
		if (isGraphItemRefContext(item, 'branch')) {
			const { ref } = item.webviewItemValue;
			if (ref.upstream != null) {
				return this.container.searchAndCompareView.compare(ref.repoPath, ref.ref, ref.upstream.name);
			}
		}

		return Promise.resolve();
	}

	@debug()
	private compareWorkingWith(item: GraphItemContext) {
		if (isGraphItemRefContext(item)) {
			const { ref } = item.webviewItemValue;
			return this.container.searchAndCompareView.compare(ref.repoPath, '', ref.ref);
		}

		return Promise.resolve();
	}

	@debug()
	private addAuthor(item: GraphItemContext) {
		if (isGraphItemTypedContext(item, 'contributor')) {
			const { repoPath, name, email, current } = item.webviewItemValue;
			return GitActions.Contributor.addAuthors(
				repoPath,
				new GitContributor(repoPath, name, email, 0, undefined, current),
			);
		}

		return Promise.resolve();
	}

	@debug()
	private async toggleColumn(name: GraphColumnName, visible: boolean) {
		let columns = this.container.storage.getWorkspace('graph:columns');
		let column = columns?.[name];
		if (column != null) {
			column.isHidden = !visible;
		} else {
			column = { isHidden: !visible };
		}

		columns = updateRecordValue(columns, name, column);
		await this.container.storage.storeWorkspace('graph:columns', columns);

		void this.notifyDidChangeColumns();
	}
}

function formatRepositories(repositories: Repository[]): GraphRepository[] {
	if (repositories.length === 0) return repositories;

	return repositories.map(r => ({
		formattedName: r.formattedName,
		id: r.id,
		name: r.name,
		path: r.path,
	}));
}

export type GraphItemContext = WebviewItemContext<GraphItemContextValue>;
export type GraphItemContextValue = GraphColumnsContextValue | GraphItemTypedContextValue | GraphItemRefContextValue;

export type GraphItemGroupContext = WebviewItemGroupContext<GraphItemGroupContextValue>;
export type GraphItemGroupContextValue = GraphItemRefGroupContextValue;

export type GraphItemRefContext<T = GraphItemRefContextValue> = WebviewItemContext<T>;
export type GraphItemRefContextValue =
	| GraphBranchContextValue
	| GraphCommitContextValue
	| GraphStashContextValue
	| GraphTagContextValue;

export type GraphItemRefGroupContext<T = GraphItemRefGroupContextValue> = WebviewItemGroupContext<T>;
export interface GraphItemRefGroupContextValue {
	type: 'refGroup';
	refs: (GitBranchReference | GitTagReference)[];
}

export type GraphItemTypedContext<T = GraphItemTypedContextValue> = WebviewItemContext<T>;
export type GraphItemTypedContextValue = GraphContributorContextValue | GraphPullRequestContextValue;

export type GraphColumnsContextValue = string;

export interface GraphContributorContextValue {
	type: 'contributor';
	repoPath: string;
	name: string;
	email: string | undefined;
	current?: boolean;
}

export interface GraphPullRequestContextValue {
	type: 'pullrequest';
	id: string;
	url: string;
}

export interface GraphBranchContextValue {
	type: 'branch';
	ref: GitBranchReference;
}

export interface GraphCommitContextValue {
	type: 'commit';
	ref: GitRevisionReference;
}

export interface GraphStashContextValue {
	type: 'stash';
	ref: GitStashReference;
}

export interface GraphTagContextValue {
	type: 'tag';
	ref: GitTagReference;
}

function isGraphItemContext(item: unknown): item is GraphItemContext {
	if (item == null) return false;

	return isWebviewItemContext(item) && item.webview === 'gitlens.graph';
}

function isGraphItemGroupContext(item: unknown): item is GraphItemGroupContext {
	if (item == null) return false;

	return isWebviewItemGroupContext(item) && item.webview === 'gitlens.graph';
}

function isGraphItemTypedContext(
	item: unknown,
	type: 'contributor',
): item is GraphItemTypedContext<GraphContributorContextValue>;
function isGraphItemTypedContext(
	item: unknown,
	type: 'pullrequest',
): item is GraphItemTypedContext<GraphPullRequestContextValue>;
function isGraphItemTypedContext(
	item: unknown,
	type: GraphItemTypedContextValue['type'],
): item is GraphItemTypedContext {
	if (item == null) return false;

	return isGraphItemContext(item) && typeof item.webviewItemValue === 'object' && item.webviewItemValue.type === type;
}

function isGraphItemRefGroupContext(item: unknown): item is GraphItemRefGroupContext {
	if (item == null) return false;

	return (
		isGraphItemGroupContext(item) &&
		typeof item.webviewItemGroupValue === 'object' &&
		item.webviewItemGroupValue.type === 'refGroup'
	);
}

function isGraphItemRefContext(item: unknown): item is GraphItemRefContext;
function isGraphItemRefContext(item: unknown, refType: 'branch'): item is GraphItemRefContext<GraphBranchContextValue>;
function isGraphItemRefContext(
	item: unknown,
	refType: 'revision',
): item is GraphItemRefContext<GraphCommitContextValue>;
function isGraphItemRefContext(item: unknown, refType: 'stash'): item is GraphItemRefContext<GraphStashContextValue>;
function isGraphItemRefContext(item: unknown, refType: 'tag'): item is GraphItemRefContext<GraphTagContextValue>;
function isGraphItemRefContext(item: unknown, refType?: GitReference['refType']): item is GraphItemRefContext {
	if (item == null) return false;

	return (
		isGraphItemContext(item) &&
		typeof item.webviewItemValue === 'object' &&
		'ref' in item.webviewItemValue &&
		(refType == null || item.webviewItemValue.ref.refType === refType)
	);
}

function getRepoPathFromBranchOrTagId(id: string): string {
	return id.split('|', 1)[0];
}
