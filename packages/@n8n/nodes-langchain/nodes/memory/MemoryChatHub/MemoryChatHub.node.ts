import { BufferWindowMemory } from '@langchain/classic/memory';
import {
	NodeConnectionTypes,
	NodeOperationError,
	type INodeType,
	type INodeTypeDescription,
	type ISupplyDataFunctions,
	type SupplyData,
} from 'n8n-workflow';

import { getSessionId } from '@utils/helpers';
import { logWrapper } from '@utils/logWrapper';
import { getConnectionHintNoticeField } from '@utils/sharedFields';

import {
	sessionIdOption,
	sessionKeyProperty,
	contextWindowLengthProperty,
	expressionSessionKeyProperty,
} from '../descriptions';

import { ChatHubMessageHistory } from './ChatHubMessageHistory';

export class MemoryChatHub implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Chat Hub Memory',
		name: 'memoryChatHub',
		icon: 'fa:comments',
		iconColor: 'blue',
		group: ['transform'],
		version: 1,
		description: 'Stores chat history in n8n Chat Hub for persistent conversations',
		defaults: {
			name: 'Chat Hub Memory',
		},
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Memory'],
				Memory: ['For beginners'],
			},
			resources: {
				primaryDocumentation: [
					{
						url: 'https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.memorychathub/',
					},
				],
			},
		},
		inputs: [],
		outputs: [NodeConnectionTypes.AiMemory],
		outputNames: ['Memory'],
		properties: [
			getConnectionHintNoticeField([NodeConnectionTypes.AiAgent]),
			{
				displayName:
					'This memory stores conversations in n8n Chat Hub, enabling persistent chat history with support for edit/retry branching.',
				name: 'chatHubNotice',
				type: 'notice',
				default: '',
			},
			sessionIdOption,
			expressionSessionKeyProperty(1),
			sessionKeyProperty,
			contextWindowLengthProperty,
			{
				// Hidden parameter for parentMessageId - injected by Chat Hub service
				displayName: 'Parent Message ID',
				name: 'parentMessageId',
				type: 'hidden',
				default: '',
				description: 'ID of the parent message that triggered this execution (set by Chat Hub)',
			},
			{
				// Hidden parameter for excludeCurrentFromMemory - injected by Chat Hub service for regeneration
				displayName: 'Exclude Current From Memory',
				name: 'excludeCurrentFromMemory',
				type: 'hidden',
				default: false,
				description:
					'Whether to exclude memory entries from the current parentMessageId (used for regeneration)',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				default: {},
				placeholder: 'Add Option',
				options: [
					{
						displayName: 'Auto-Create Session',
						name: 'autoCreateSession',
						type: 'boolean',
						default: true,
						description: 'Whether to automatically create a Chat Hub session if one does not exist',
					},
					{
						displayName: 'Session Title',
						name: 'sessionTitle',
						type: 'string',
						default: 'Workflow Chat',
						description: 'Title for auto-created sessions',
						displayOptions: {
							show: {
								autoCreateSession: [true],
							},
						},
					},
				],
			},
		],
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const sessionId = getSessionId(this, itemIndex);
		const contextWindowLength = this.getNodeParameter('contextWindowLength', itemIndex) as number;
		const parentMessageId =
			(this.getNodeParameter('parentMessageId', itemIndex, '') as string) || null;
		const excludeCurrentFromMemory = this.getNodeParameter(
			'excludeCurrentFromMemory',
			itemIndex,
			false,
		) as boolean;
		const options = this.getNodeParameter('options', itemIndex, {}) as {
			autoCreateSession?: boolean;
			sessionTitle?: string;
		};

		// Get the node's internal ID to use as memoryNodeId
		const node = this.getNode();
		const memoryNodeId = node.id;

		// Get the Chat Hub proxy
		// parentMessageId may be null for manual executions - proxy will look up latest message
		// excludeCurrentFromMemory is true for regeneration - excludes memory from the current parentMessageId
		const memoryService = await this.helpers.getChatHubProxy?.(
			sessionId,
			memoryNodeId,
			parentMessageId,
			excludeCurrentFromMemory,
		);

		if (!memoryService) {
			throw new NodeOperationError(
				node,
				'Chat Hub module is not available. Ensure the chat-hub module is enabled.',
			);
		}

		// Auto-create session if needed
		if (options.autoCreateSession !== false) {
			await memoryService.ensureSession(options.sessionTitle);
		}

		const chatHistory = new ChatHubMessageHistory({
			memoryService,
		});

		const memory = new BufferWindowMemory({
			k: contextWindowLength,
			memoryKey: 'chat_history',
			chatHistory,
			returnMessages: true,
			inputKey: 'input',
			outputKey: 'output',
		});

		return {
			response: logWrapper(memory, this),
		};
	}
}
