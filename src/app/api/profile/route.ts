import 'server-only';
import { getProfile, chooseProfile } from '@/lib/profile-http';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const GET=getProfile;
export const POST=chooseProfile;
