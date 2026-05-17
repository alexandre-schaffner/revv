import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

export const load: PageLoad = ({ params }) => {
  throw redirect(301, `/repo/${params.repoId}/recaps`);
};
