import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

export class XiaomiMiMoNextApi implements ICredentialType {
	name = 'xiaomiMiMoNextApi';

	displayName = 'Xiaomi MiMo API (Next)';

	icon: Icon = 'file:xiaomi.svg';

	documentationUrl = 'https://platform.xiaomimimo.com/docs/zh-CN/quick-start/first-api-call';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.xiaomimimo.com/v1',
			description: 'OpenAI-compatible base URL for Xiaomi MiMo API',
			required: true,
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{ $credentials.baseUrl }}',
			url: '/models',
		},
	};
}
