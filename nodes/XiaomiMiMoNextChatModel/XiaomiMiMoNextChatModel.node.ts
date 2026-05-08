import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { BaseMessage } from '@langchain/core/messages';
import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { N8nLlmTracing } from '@n8n/ai-utilities';
import {
	ChatOpenAICompletions,
	type ChatOpenAICompletionsCallOptions,
	type ClientOptions,
} from '@langchain/openai';
import type OpenAI from 'openai';
import { ProxyAgent } from 'undici';
import {
	NodeConnectionTypes,
	NodeOperationError,
	type ILoadOptionsFunctions,
	type INode,
	type INodePropertyOptions,
	type INodeType,
	type INodeTypeDescription,
	type ISupplyDataFunctions,
	type SupplyData,
} from 'n8n-workflow';

/**
 * n8n calls `supplyData()` on the model node on every engine cycle (including each
 * EngineResponse after tool execution), creating a brand-new `ChatMiMoForN8n` instance
 * each time. An instance-level Map is therefore wiped between the "first LLM call that
 * returns tool_calls + reasoning_content" and the "second LLM call that must echo it back".
 *
 * A module-level Map persists across instances for the lifetime of the Node.js process
 * and is the only reliable way to carry `reasoning_content` across engine cycles.
 *
 * Key  = sorted tool-call IDs joined by '|'
 * Value = { reasoning, ts }
 */
interface ReasoningCacheEntry {
	reasoning: string;
	ts: number;
}
const MODULE_REASONING_CACHE = new Map<string, ReasoningCacheEntry>();
const MODULE_REASONING_CACHE_MAX = 512;
const MODULE_REASONING_CACHE_TTL_MS = 15 * 60 * 1000; // 15 min

function moduleReasoningCacheSet(sig: string, reasoning: string): void {
	if (!sig || !reasoning) return;
	MODULE_REASONING_CACHE.set(sig, { reasoning, ts: Date.now() });
	while (MODULE_REASONING_CACHE.size > MODULE_REASONING_CACHE_MAX) {
		const first = MODULE_REASONING_CACHE.keys().next().value;
		if (first === undefined) break;
		MODULE_REASONING_CACHE.delete(first);
	}
}

function moduleReasoningCacheGet(sig: string): string | undefined {
	const entry = MODULE_REASONING_CACHE.get(sig);
	if (!entry) return undefined;
	if (Date.now() - entry.ts > MODULE_REASONING_CACHE_TTL_MS) {
		MODULE_REASONING_CACHE.delete(sig);
		return undefined;
	}
	return entry.reasoning;
}

const STATIC_MODEL_IDS = [
	'mimo-v2.5-pro',
	'mimo-v2.5',
	'mimo-v2-pro',
	'mimo-v2-omni',
	'mimo-v2-flash',
] as const;

/** MiMo chat/completions rejects tools whose parameter schema root is missing type:"object". */
function normalizeMiMoCompletionTool(tool: unknown): unknown {
	if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return tool;
	const t = tool as Record<string, unknown>;
	if (t.type !== 'function') return tool;
	const fn = t.function;
	if (!fn || typeof fn !== 'object' || Array.isArray(fn)) return tool;
	const func = fn as Record<string, unknown>;
	const params = func.parameters;
	if (params === undefined || params === null || typeof params !== 'object' || Array.isArray(params)) {
		func.parameters = { type: 'object', properties: {} };
		return tool;
	}
	const p = params as Record<string, unknown>;
	if (p.type === 'object') return tool;
	const props =
		p.properties !== undefined &&
		typeof p.properties === 'object' &&
		p.properties !== null &&
		!Array.isArray(p.properties)
			? (p.properties as Record<string, unknown>)
			: {};
	const next: Record<string, unknown> = {
		type: 'object',
		properties: props,
	};
	if (Array.isArray(p.required)) next.required = p.required;
	if (p.additionalProperties !== undefined) next.additionalProperties = p.additionalProperties;
	func.parameters = next;
	return tool;
}

/** Stable key for tool_calls arrays based on sorted IDs. */
function stableToolSignatureFromCalls(toolCalls: unknown): string | undefined {
	if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined;
	const ids: string[] = [];
	for (const t of toolCalls) {
		if (!t || typeof t !== 'object') continue;
		const id = (t as { id?: unknown }).id;
		if (typeof id === 'string' && id.length > 0) ids.push(id);
	}
	if (ids.length === 0) return undefined;
	ids.sort();
	return ids.join('|');
}

function extractReasoningContentFromAiMessage(msg: AIMessage): string | undefined {
	const ak = msg.additional_kwargs as Record<string, unknown> | undefined;
	if (!ak) return undefined;
	const rc = ak.reasoning_content;
	if (typeof rc === 'string' && rc.length > 0) return rc;
	const reasoning = ak.reasoning;
	if (typeof reasoning === 'string' && reasoning.length > 0) return reasoning;
	return undefined;
}

/**
 * MiMo thinking mode requires prior-turn reasoning_content to be echoed on
 * continuation requests (tools / multi-turn), same as DeepSeek.
 */
function injectMiMoAssistantReasoningIntoApiMessages(
	lcMessages: BaseMessage[],
	apiMessages: Record<string, unknown>[],
	reasoningFallbackByToolSignature?: Map<string, string>,
): void {
	const lcAi = lcMessages.filter(AIMessage.isInstance);
	const assistantApiIndexes = apiMessages
		.map((row, idx) => (row && row.role === 'assistant' ? idx : -1))
		.filter((idx) => idx >= 0);

	const usedLcAi = new Set<number>();

	for (const paramIdx of assistantApiIndexes) {
		const row = apiMessages[paramIdx];
		const existing = row.reasoning_content;
		if (typeof existing === 'string' && existing.length > 0) continue;

		const rawToolCalls = row.tool_calls as Array<{ id?: string }> | undefined;
		let chosenLcIdx = -1;

		if (rawToolCalls && rawToolCalls.length > 0) {
			const ids = new Set(
				rawToolCalls.map((t) => t.id).filter((id): id is string => typeof id === 'string' && id.length > 0),
			);
			chosenLcIdx = lcAi.findIndex(
				(m, i) =>
					!usedLcAi.has(i) && (m.tool_calls?.some((tc) => tc.id && ids.has(tc.id)) ?? false),
			);
		}

		if (chosenLcIdx < 0) {
			chosenLcIdx = lcAi.findIndex((_, i) => !usedLcAi.has(i));
		}
		if (chosenLcIdx < 0) continue;
		usedLcAi.add(chosenLcIdx);

		const rc = extractReasoningContentFromAiMessage(lcAi[chosenLcIdx]);
		if (typeof rc !== 'string' || rc.length === 0) continue;
		apiMessages[paramIdx] = { ...row, reasoning_content: rc };
	}

	// Second pass: consult caches for rows still missing reasoning_content.
	for (const paramIdx of assistantApiIndexes) {
		const row = apiMessages[paramIdx];
		if (typeof row.reasoning_content === 'string' && row.reasoning_content.length > 0) continue;
		const sig = stableToolSignatureFromCalls(row.tool_calls);
		if (!sig) continue;
		const cached =
			reasoningFallbackByToolSignature?.get(sig) ?? moduleReasoningCacheGet(sig);
		if (typeof cached !== 'string' || cached.length === 0) continue;
		apiMessages[paramIdx] = { ...row, reasoning_content: cached };
	}
}

/**
 * ChatOpenAI extension for Xiaomi MiMo:
 * - Normalizes tool schemas
 * - Injects reasoning_content across multi-turn tool calls
 * - Mirrors reasoning stream deltas into content for n8n Agent aggregation
 */
class ChatMiMoForN8n extends ChatOpenAICompletions {
	n8nMirrorReasoningStreamForAgent = false;

	private reasoningContentByToolSignature = new Map<string, string>();
	private mimoLcMessagesStack: BaseMessage[][] = [];

	private rememberReasoningForToolSignature(signature: string, reasoning: string): void {
		if (!signature || reasoning.length === 0) return;
		moduleReasoningCacheSet(signature, reasoning);
		this.reasoningContentByToolSignature.set(signature, reasoning);
		while (this.reasoningContentByToolSignature.size > 64) {
			const first = this.reasoningContentByToolSignature.keys().next().value;
			if (first === undefined) break;
			this.reasoningContentByToolSignature.delete(first);
		}
	}

	protected override _convertChatOpenAIToolToCompletionsTool(
		tool: Parameters<ChatOpenAICompletions['_convertChatOpenAIToolToCompletionsTool']>[0],
		fields?: Parameters<ChatOpenAICompletions['_convertChatOpenAIToolToCompletionsTool']>[1],
	): ReturnType<ChatOpenAICompletions['_convertChatOpenAIToolToCompletionsTool']> {
		const converted = super._convertChatOpenAIToolToCompletionsTool(tool, fields);
		return normalizeMiMoCompletionTool(converted) as ReturnType<
			ChatOpenAICompletions['_convertChatOpenAIToolToCompletionsTool']
		>;
	}

	override completionWithRetry(
		request: OpenAI.Chat.ChatCompletionCreateParamsStreaming,
		requestOptions?: OpenAI.RequestOptions,
	): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>>;
	override completionWithRetry(
		request: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
		requestOptions?: OpenAI.RequestOptions,
	): Promise<OpenAI.Chat.Completions.ChatCompletion>;
	override async completionWithRetry(
		request:
			| OpenAI.Chat.ChatCompletionCreateParamsStreaming
			| OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
		requestOptions?: OpenAI.RequestOptions,
	): Promise<
		AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> | OpenAI.Chat.Completions.ChatCompletion
	> {
		const stackTop = this.mimoLcMessagesStack[this.mimoLcMessagesStack.length - 1];
		if (stackTop && Array.isArray(request.messages)) {
			injectMiMoAssistantReasoningIntoApiMessages(
				stackTop,
				request.messages as unknown as Record<string, unknown>[],
				this.reasoningContentByToolSignature,
			);
		}
		if (request.stream === true) {
			return super.completionWithRetry(
				request as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
				requestOptions,
			);
		}
		const result = await super.completionWithRetry(
			request as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
			requestOptions,
		);
		if (result && typeof result === 'object' && 'choices' in result) {
			const msg = (result as OpenAI.Chat.Completions.ChatCompletion).choices?.[0]?.message as
				| (OpenAI.Chat.Completions.ChatCompletionMessage & {
						reasoning_content?: string | null;
				  })
				| undefined;
			const rc = msg?.reasoning_content;
			const tc = msg?.tool_calls;
			if (typeof rc === 'string' && rc.length > 0 && Array.isArray(tc) && tc.length > 0) {
				const sig = stableToolSignatureFromCalls(tc);
				if (sig) this.rememberReasoningForToolSignature(sig, rc);
			}
		}
		return result;
	}

	override async _generate(
		messages: BaseMessage[],
		options: ChatOpenAICompletionsCallOptions,
		runManager?: CallbackManagerForLLMRun,
	): Promise<ChatResult> {
		this.mimoLcMessagesStack.push(messages);
		try {
			return await super._generate(messages, options, runManager);
		} finally {
			this.mimoLcMessagesStack.pop();
		}
	}

	public override async *_streamResponseChunks(
		messages: BaseMessage[],
		options: ChatOpenAICompletionsCallOptions,
		runManager?: CallbackManagerForLLMRun,
	): AsyncGenerator<ChatGenerationChunk> {
		this.mimoLcMessagesStack.push(messages);
		try {
			const upstream = super._streamResponseChunks(messages, options, runManager);
			let streamReasoningAgg = '';
			const streamToolCallIds = new Set<string>();

			const flushReasoningCache = (): void => {
				if (streamToolCallIds.size > 0 && streamReasoningAgg.length > 0) {
					const sig = [...streamToolCallIds].sort().join('|');
					this.rememberReasoningForToolSignature(sig, streamReasoningAgg);
				}
				streamReasoningAgg = '';
				streamToolCallIds.clear();
			};

			for await (const chunk of upstream) {
				const msg = chunk.message as AIMessageChunk;
				const ak = msg.additional_kwargs as Record<string, unknown> | undefined;
				const deltaRc = ak?.reasoning_content;

				if (typeof deltaRc === 'string' && deltaRc.length > 0) {
					streamReasoningAgg += deltaRc;
				}

				if (msg.tool_call_chunks) {
					for (const tc of msg.tool_call_chunks) {
						if (tc.id && tc.id.length > 0) streamToolCallIds.add(tc.id);
					}
				}
				if (msg.tool_calls) {
					for (const tc of msg.tool_calls) {
						if (tc.id && tc.id.length > 0) streamToolCallIds.add(tc.id);
					}
				}

				const fr = chunk.generationInfo?.finish_reason;
				if (fr) {
					flushReasoningCache();
				}

				if (!this.n8nMirrorReasoningStreamForAgent) {
					yield chunk;
					continue;
				}

				const text = chunk.text ?? '';
				const rcStr = typeof deltaRc === 'string' ? deltaRc : '';

				const toolCallsLen = msg.tool_calls?.length ?? 0;
				const toolCallChunksLen = msg.tool_call_chunks?.length ?? 0;
				const hasToolStreaming = toolCallsLen > 0 || toolCallChunksLen > 0;

				if (!hasToolStreaming && text.length === 0 && rcStr.length > 0) {
					yield new ChatGenerationChunk({
						message: new AIMessageChunk({
							content: rcStr,
							additional_kwargs: { ...ak },
							response_metadata: msg.response_metadata,
							tool_calls: msg.tool_calls,
							tool_call_chunks: msg.tool_call_chunks,
							invalid_tool_calls: msg.invalid_tool_calls,
							id: msg.id,
						}),
						text: rcStr,
						generationInfo: chunk.generationInfo,
					});
				} else {
					yield chunk;
				}
			}

			flushReasoningCache();
		} finally {
			this.mimoLcMessagesStack.pop();
		}
	}
}

function normalizeBaseUrl(url: string): string {
	return String(url).trim().replace(/\/+$/, '');
}

function parseAdditionalModelKwargs(raw: unknown, node: INode): Record<string, unknown> {
	if (raw === undefined || raw === null) {
		return {};
	}
	if (typeof raw === 'string') {
		const s = raw.trim();
		if (!s) {
			return {};
		}
		try {
			const parsed: unknown = JSON.parse(s);
			if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return { ...(parsed as Record<string, unknown>) };
			}
			throw new NodeOperationError(
				node,
				'Additional model arguments must be a JSON object (e.g. {"key":"value"}).',
			);
		} catch (e) {
			if (e instanceof NodeOperationError) throw e;
			throw new NodeOperationError(node, 'Invalid JSON in additional model arguments.');
		}
	}
	if (typeof raw === 'object' && !Array.isArray(raw)) {
		return { ...(raw as Record<string, unknown>) };
	}
	return {};
}

async function getModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const credentials = await this.getCredentials('xiaomiMiMoNextApi');
	const apiKey = credentials.apiKey as string;
	const baseUrl = normalizeBaseUrl((credentials.baseUrl as string) || 'https://api.xiaomimimo.com/v1');
	try {
		const response = (await this.helpers.httpRequest({
			method: 'GET',
			url: `${baseUrl}/models`,
			headers: {
				Accept: 'application/json',
				Authorization: `Bearer ${apiKey}`,
			},
			json: true,
		})) as { data?: Array<{ id?: string }> };

		const data = response?.data;
		if (!Array.isArray(data)) {
			throw new Error('Unexpected /models response shape');
		}
		const ids = data
			.map((m) => (typeof m?.id === 'string' ? m.id : ''))
			.filter((id): id is string => Boolean(id));
		const unique = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
		if (unique.length === 0) {
			throw new Error('Empty /models data array');
		}
		return unique.map((name) => ({ name, value: name }));
	} catch {
		return [...STATIC_MODEL_IDS].map((name) => ({ name, value: name }));
	}
}

export class XiaomiMiMoNextChatModel implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Xiaomi MiMo Chat Model (Next)',
		name: 'xiaomiMiMoNextChatModel',
		icon: 'file:xiaomi.svg',
		group: ['transform'],
		version: [1],
		description:
			'Xiaomi MiMo chat model via OpenAI-compatible API (thinking mode, multimodal, web search). Community node.',
		defaults: {
			name: 'Xiaomi MiMo Chat Model (Next)',
		},
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Language Models', 'Root Nodes'],
				'Language Models': ['Chat Models (Recommended)'],
			},
			resources: {
				primaryDocumentation: [
					{ url: 'https://platform.xiaomimimo.com/docs/zh-CN/quick-start/first-api-call' },
				],
			},
		},
		inputs: [],
		outputs: [NodeConnectionTypes.AiLanguageModel],
		outputNames: ['Model'],
		credentials: [
			{
				name: 'xiaomiMiMoNextApi',
				required: true,
			},
		],
		properties: [
			{
				displayName:
					'This node must be connected to an <a data-action="openSelectiveNodeCreator" data-action-parameter-connectiontype="ai_chain">AI Chain</a> or <a data-action="openSelectiveNodeCreator" data-action-parameter-connectiontype="ai_agent">AI Agent</a>.',
				name: 'connectionNotice',
				type: 'notice',
				default: '',
				typeOptions: {
					containerClass: 'ndv-connection-hint-notice',
				},
			},
			{
				displayName:
					'If using JSON response format, include the word "json" in the prompt where required by the model provider.',
				name: 'jsonFormatNotice',
				type: 'notice',
				default: '',
				displayOptions: {
					show: {
						'/options.responseFormat': ['json_object'],
					},
				},
			},
			{
				displayName:
					'With thinking mode enabled, sampling parameters such as temperature and top P have no effect on the thinking phase.',
				name: 'thinkingParamsNotice',
				type: 'notice',
				default: '',
				displayOptions: {
					show: {
						'/options.thinkingMode': ['enabled'],
					},
				},
			},
			{
				displayName:
					'When Thinking Mode is Disabled, this node mirrors MiMo `reasoning_content` stream deltas into normal assistant text so n8n AI Agent streaming can aggregate output.',
				name: 'n8nAgentStreamNotice',
				type: 'notice',
				default: '',
				displayOptions: {
					show: {
						'/options.thinkingMode': ['disabled'],
					},
				},
			},
			{
				displayName: 'Model',
				name: 'model',
				type: 'options',
				description:
					'Model id from your Xiaomi MiMo <a href="https://platform.xiaomimimo.com/docs/zh-CN/quick-start/first-api-call" target="_blank" rel="noopener noreferrer">OpenAI-compatible API</a>. Options are loaded from GET /models when available; otherwise static fallbacks apply. Multimodal (image/audio/video) requires mimo-v2.5 or mimo-v2-omni.',
				typeOptions: {
					loadOptionsMethod: 'getModels',
				},
				default: 'mimo-v2.5-pro',
			},
			{
				displayName: 'Options',
				name: 'options',
				placeholder: 'Add Option',
				type: 'collection',
				default: {},
				options: [
					{
						displayName: 'Thinking Mode',
						name: 'thinkingMode',
						type: 'options',
						description:
							'Enable MiMo thinking mode to get reasoning_content in responses. Disabled by default for predictable cost and latency.',
						default: 'disabled',
						options: [
							{
								name: 'Disabled',
								value: 'disabled',
								description: 'Send thinking: disabled (this node default).',
							},
							{
								name: 'Enabled',
								value: 'enabled',
								description: 'Send thinking: enabled (reasoning_content in responses).',
							},
						],
					},
					{
						displayName: 'Web Search',
						name: 'webSearch',
						type: 'boolean',
						default: false,
						description:
							'Whether to enable MiMo built-in web search. Requires the web search plugin to be activated in the MiMo console first. When enabled, sends type:"web_search" in the tools array.',
					},
					{
						displayName: 'Force Web Search',
						name: 'forceSearch',
						type: 'boolean',
						default: false,
						description:
							'Whether to force a web search even when the model judges it unnecessary. Only applies when Web Search is enabled.',
						displayOptions: {
							show: {
								'/options.webSearch': [true],
							},
						},
					},
					{
						displayName: 'Stream',
						name: 'stream',
						type: 'boolean',
						default: true,
						description:
							'Whether to stream tokens from the model. Leave enabled for AI Agent streaming responses.',
					},
					{
						displayName: 'Parallel Tool Calls',
						name: 'parallelToolCalls',
						type: 'boolean',
						default: false,
						description:
							'When off (default), at most one function/tool call per model turn. Reduces burst tool usage that burns Tools Agent Max iterations.',
					},
					{
						displayName: 'Sampling Temperature',
						name: 'temperature',
						default: 1.0,
						type: 'number',
						typeOptions: { maxValue: 1.5, minValue: 0, numberPrecision: 2 },
						description:
							'Sampling temperature in [0, 1.5]. Higher values produce more varied output. Default 1.0 for pro/omni models; 0.3 for flash.',
					},
					{
						displayName: 'Top P',
						name: 'topP',
						type: 'number',
						default: 0.95,
						typeOptions: { maxValue: 1, minValue: 0.01, numberPrecision: 2 },
						description: 'Nucleus sampling threshold in [0.01, 1.0]. Default 0.95.',
					},
					{
						displayName: 'Frequency Penalty',
						name: 'frequencyPenalty',
						default: 0,
						type: 'number',
						typeOptions: { maxValue: 2, minValue: -2, numberPrecision: 2 },
						description:
							'Penalizes tokens by frequency in the text so far (reduces verbatim repetition).',
					},
					{
						displayName: 'Presence Penalty',
						name: 'presencePenalty',
						default: 0,
						type: 'number',
						typeOptions: { maxValue: 2, minValue: -2, numberPrecision: 2 },
						description: 'Penalizes tokens that already appeared (encourages new topics).',
					},
					{
						displayName: 'Maximum Number of Tokens',
						name: 'maxTokens',
						default: -1,
						type: 'number',
						typeOptions: { maxValue: 131072 },
						description:
							'Max completion tokens. Use -1 or leave default to omit the limit (provider default).',
					},
					{
						displayName: 'Response Format',
						name: 'responseFormat',
						type: 'options',
						default: 'text',
						options: [
							{ name: 'Text', value: 'text' },
							{ name: 'JSON Object', value: 'json_object' },
						],
					},
					{
						displayName: 'Timeout',
						name: 'timeout',
						type: 'number',
						default: 360000,
						description: 'Request timeout in milliseconds.',
					},
					{
						displayName: 'Max Retries',
						name: 'maxRetries',
						type: 'number',
						default: 2,
					},
					{
						displayName: 'Additional Model Arguments',
						name: 'additionalModelKwargs',
						type: 'json',
						default: '',
						description:
							'Optional extra fields merged (shallow) into modelKwargs after thinking / response_format.',
					},
				],
			},
		],
	};

	methods = {
		loadOptions: {
			getModels,
		},
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const credentials = await this.getCredentials('xiaomiMiMoNextApi');
		const apiKey = credentials.apiKey as string;
		const baseUrl = normalizeBaseUrl(
			(credentials.baseUrl as string) || 'https://api.xiaomimimo.com/v1',
		);

		const modelName = this.getNodeParameter('model', itemIndex) as string;

		const options = this.getNodeParameter('options', itemIndex, {}) as {
			thinkingMode?: 'enabled' | 'disabled';
			webSearch?: boolean;
			forceSearch?: boolean;
			stream?: boolean;
			parallelToolCalls?: boolean;
			temperature?: number;
			topP?: number;
			frequencyPenalty?: number;
			presencePenalty?: number;
			maxTokens?: number;
			responseFormat?: 'text' | 'json_object';
			timeout?: number;
			maxRetries?: number;
			additionalModelKwargs?: unknown;
		};

		const thinkingMode = options.thinkingMode ?? 'disabled';
		const timeout = options.timeout ?? 360000;
		const maxRetries = options.maxRetries ?? 2;
		const stream = options.stream ?? true;
		const parallelToolCalls = options.parallelToolCalls ?? false;

		const proxyUrl = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
		const configuration: ClientOptions = {
			baseURL: baseUrl,
			...(proxyUrl
				? {
						fetchOptions: {
							dispatcher: new ProxyAgent({
								uri: proxyUrl,
								headersTimeout: timeout,
								bodyTimeout: timeout,
							}),
						},
					}
				: {}),
		};

		const modelKwargs: Record<string, unknown> = {
			thinking:
				thinkingMode === 'enabled'
					? { type: 'enabled' as const }
					: { type: 'disabled' as const },
		};

		if (options.responseFormat === 'json_object') {
			modelKwargs.response_format = { type: 'json_object' };
		}

		// Web search plugin: pass as tools in extra_body via modelKwargs
		if (options.webSearch === true) {
			modelKwargs.tools = [
				{
					type: 'web_search',
					force_search: options.forceSearch === true,
				},
			];
		}

		const additional = parseAdditionalModelKwargs(options.additionalModelKwargs, this.getNode());
		Object.assign(modelKwargs, additional);

		const maxTokens =
			options.maxTokens !== undefined && options.maxTokens !== null && options.maxTokens >= 0
				? options.maxTokens
				: undefined;

		const model = new ChatMiMoForN8n({
			model: modelName,
			apiKey,
			supportsStrictToolCalling: false,
			streaming: stream,
			parallel_tool_calls: parallelToolCalls,
			callbacks: [new N8nLlmTracing(this)],
			configuration,
			timeout,
			maxRetries,
			...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
			...(options.topP !== undefined ? { topP: options.topP } : {}),
			...(options.frequencyPenalty !== undefined
				? { frequencyPenalty: options.frequencyPenalty }
				: {}),
			...(options.presencePenalty !== undefined
				? { presencePenalty: options.presencePenalty }
				: {}),
			...(maxTokens !== undefined ? { maxTokens } : {}),
			modelKwargs,
		} as ConstructorParameters<typeof ChatOpenAICompletions>[0]);

		model.n8nMirrorReasoningStreamForAgent = thinkingMode === 'disabled';

		return { response: model };
	}
}
