# Address Revv feedback

1. Call `get_review_context` before searching the checkout. Treat its issue
   IDs, thread IDs, and walkthrough targeting keys as authoritative. For
   write tools, pass `walkthrough.reviewedHeadSha` as `expected_head_sha`;
   `pr.headSha` may advance after you push the fix.
2. State which issue or thread you are addressing. Inspect the referenced code
   and implement the smallest complete fix.
3. Run the repository's required checks. Do not claim an issue is addressed
   from code inspection alone when an executable check is available.
4. For a local walkthrough issue, call `record_issue_resolution` with:
   - `status: addressed` only after verification;
   - a concise explanation of the change;
   - concrete evidence such as test commands and touched files;
   - the current commit SHA when the fix has been committed.
5. If the implementation changes an explanation or conclusion in the
   walkthrough, call `get_walkthrough_for_edit` and use the available targeted
   update tools. Preserve unrelated content.
6. For reviewer conversations, generate one idempotency key per intended reply
   and reuse that key on retries. Set `publish_to_github` explicitly. Resolve a
   thread only when the feedback is actually addressed; otherwise use
   `pending_reviewer` or leave it open.
7. GitHub-submitted walkthrough issues are immutable. Address their linked
   thread instead of attempting to rewrite or resolve the issue row.

Never mark feedback resolved merely because code was edited. Record the actual
verification result, and leave the item open if verification failed or was not
run.
