import { ConnectPage } from '@/components/workspace/connect-page';

type Params = Record<string, string | string[] | undefined>;
const one = (value: string | string[] | undefined) => typeof value === 'string' ? value : undefined;

export default async function ConnectRoute({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  return <ConnectPage request={{ clientId: one(params.client_id), redirectUri: one(params.redirect_uri), codeChallenge: one(params.code_challenge), codeChallengeMethod: one(params.code_challenge_method), state: one(params.state), resource: one(params.resource), handle: one(params.handle), clientName: one(params.client_name) }} />;
}
