import { env } from '@/env';
import { db } from '@/server/db';
import { feedbackAdminQueries, handleFeedbackScreenshot } from '@/server/feedback/admin-queries';
import { createClient } from '@/utils/supabase/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    return handleFeedbackScreenshot(req, {
        user,
        allowList: env.FEEDBACK_ADMIN_EMAILS,
        ...feedbackAdminQueries(db),
    });
}
