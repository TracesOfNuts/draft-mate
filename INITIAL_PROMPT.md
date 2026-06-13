You are an expert software architect and AI agent designer. Help me create a detailed plan for building an application, script, or bot that helps me prioritise a large backlog of emails after being away from work.

Context:
I have hundreds of unread or unprocessed emails. I want to quickly identify which emails need my attention first, especially the ones that are urgent, important, or require a reply. The tool should ideally work with Gmail and/or Outlook. I am open to using AI agents if that is the best approach. I would prefer a solution that can run locally where possible, or at least keep sensitive email content private and secure.

Main goal:
Design a practical system that reviews my emails, ranks them by priority, explains why each email is important, and helps me decide what to respond to first.

Core features:

1. Connect to Gmail and/or Outlook.
2. Fetch recent unread emails or emails from a configurable date range.
3. Analyse each email for:

   * urgency
   * importance
   * whether a reply is needed
   * deadlines or requested actions
   * sender importance
   * meeting or scheduling relevance
   * financial, legal, client, management, or operational importance
4. Assign each email a priority score, for example: Critical, High, Medium, Low.
5. Produce a ranked inbox summary with:

   * sender
   * subject
   * short summary
   * reason for priority
   * recommended next action
   * suggested reply deadline
6. Group emails into useful categories, such as:

   * reply immediately
   * needs review today
   * waiting for someone else
   * informational only
   * newsletters or automated notifications
   * likely spam or low priority
7. Optionally draft reply emails, but do not send them automatically.
8. Save suggested replies as Gmail or Outlook drafts when possible.
9. Allow me to review, edit, approve, or delete any draft before sending.
10. Keep a log of what the system analysed and what drafts it created.

Important constraints:

* The system should not send emails without explicit human approval.
* Privacy and security are very important.
* Prefer local processing where feasible.
* If cloud AI models are used, explain what email data would be sent externally and suggest ways to minimise exposure.
* The design should support both a simple MVP and a more advanced version.
* The solution should be realistic for a solo developer or technically capable user to build.

Please produce:

1. A clear product requirements document.
2. A recommended technical architecture.
3. A comparison of approaches:

   * local script
   * desktop app
   * browser extension
   * Gmail/Outlook add-on
   * AI agent workflow
4. Recommended tech stack options for Gmail and Outlook.
5. API/authentication requirements, including Gmail API and Microsoft Graph API.
6. Data flow diagram described in text.
7. AI prompt design for email classification and draft replies.
8. A priority scoring rubric.
9. Safety rules to prevent bad replies or accidental sending.
10. Suggested local-first architecture, including possible use of local LLMs.
11. MVP build plan broken into phases.
12. Pseudocode for the main workflow.
13. Example JSON schema for analysed email output.
14. Example user interface or CLI output.
15. Risks, limitations, and mitigations.
16. A recommended first version I should build.

Think step by step and be specific. Do not write code yet unless it helps explain the architecture. Focus on creating a practical build plan that I can later hand to a developer or coding AI.
