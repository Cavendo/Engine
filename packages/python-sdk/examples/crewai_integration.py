"""
CrewAI integration example for the Cavendo Python SDK.

This example shows how to use Cavendo Engine with CrewAI to build
an AI agent workflow that receives tasks from Cavendo and submits
deliverables back.

Requirements:
    pip install cavendo-engine crewai crewai-tools
"""

import os
from typing import Any

from cavendo import CavendoClient, TaskStatus, Task, TaskContext

# CrewAI imports (install with: pip install crewai)
try:
    from crewai import Agent, Task as CrewTask, Crew
    from crewai.tools import BaseTool
except ImportError:
    print("CrewAI not installed. Run: pip install crewai crewai-tools")
    raise


class CavendoKnowledgeTool(BaseTool):
    """
    CrewAI tool for searching the Cavendo knowledge base.
    """

    name: str = "cavendo_knowledge_search"
    description: str = (
        "Search the Cavendo knowledge base for relevant information. "
        "Input should be a search query string."
    )

    def __init__(self, client: CavendoClient, project_id: int | None = None):
        super().__init__()
        self._client = client
        self._project_id = project_id

    def _run(self, query: str) -> str:
        """Search the knowledge base."""
        results = self._client.knowledge.search(
            query=query,
            project_id=self._project_id,
            limit=5,
        )

        if not results:
            return "No relevant documents found."

        output = []
        for result in results:
            doc = result.document
            output.append(f"## {doc.title}\n{doc.content[:500]}...")

        return "\n\n---\n\n".join(output)


class CavendoDeliverableTool(BaseTool):
    """
    CrewAI tool for submitting deliverables to Cavendo.
    """

    name: str = "cavendo_submit_deliverable"
    description: str = (
        "Submit a deliverable for the current task. "
        "Input should be in format: 'TITLE|||CONTENT' where TITLE is the "
        "deliverable title and CONTENT is the full deliverable content."
    )

    def __init__(self, client: CavendoClient, task_id: int):
        super().__init__()
        self._client = client
        self._task_id = task_id

    def _run(self, input_str: str) -> str:
        """Submit a deliverable."""
        parts = input_str.split("|||", 1)
        if len(parts) != 2:
            return "Error: Input must be in format 'TITLE|||CONTENT'"

        title, content = parts[0].strip(), parts[1].strip()

        deliverable = self._client.deliverables.submit(
            task_id=self._task_id,
            title=title,
            content=content,
            content_type="markdown",
        )

        return f"Deliverable submitted successfully with ID: {deliverable.id}"


def create_crew_for_task(
    client: CavendoClient,
    task: Task,
    context: TaskContext,
) -> Crew:
    """
    Create a CrewAI Crew configured for a specific Cavendo task.
    """
    project_id = context.project.get("id") if context.project else None

    # Create tools
    knowledge_tool = CavendoKnowledgeTool(client, project_id)
    deliverable_tool = CavendoDeliverableTool(client, task.id)

    # Create a researcher agent
    researcher = Agent(
        role="Research Analyst",
        goal=f"Research and analyze: {task.title}",
        backstory=(
            "You are a skilled research analyst who excels at gathering "
            "information and providing comprehensive analysis."
        ),
        tools=[knowledge_tool],
        verbose=True,
    )

    # Create a writer agent
    writer = Agent(
        role="Technical Writer",
        goal=f"Create a well-structured deliverable for: {task.title}",
        backstory=(
            "You are an expert technical writer who creates clear, "
            "actionable deliverables based on research findings."
        ),
        tools=[deliverable_tool],
        verbose=True,
    )

    # Build the task description with context
    task_description = f"""
    Task: {task.title}

    Description: {task.description or 'No additional description provided.'}

    Project Context: {context.project.get('name') if context.project else 'N/A'}

    Previous Deliverables:
    {chr(10).join(f'- {d.title}' for d in context.previous_deliverables) or 'None'}

    Your job is to:
    1. Research the topic using the knowledge base
    2. Analyze the findings
    3. Create a comprehensive deliverable
    4. Submit the deliverable using the submission tool
    """

    # Create CrewAI tasks
    research_task = CrewTask(
        description=f"Research: {task.title}. Use the knowledge search tool to find relevant information.",
        expected_output="A summary of relevant findings from the knowledge base.",
        agent=researcher,
    )

    write_task = CrewTask(
        description=task_description,
        expected_output="A submitted deliverable confirmation.",
        agent=writer,
        context=[research_task],
    )

    # Create the crew
    crew = Crew(
        agents=[researcher, writer],
        tasks=[research_task, write_task],
        verbose=True,
    )

    return crew


def main() -> None:
    """Main function demonstrating CrewAI integration."""

    # Initialize Cavendo client
    client = CavendoClient(
        url=os.getenv("CAVENDO_URL", "http://localhost:3001"),
        api_key=os.getenv("CAVENDO_AGENT_KEY"),
    )

    try:
        # Get agent info
        agent = client.me()
        print(f"Starting CrewAI agent: {agent.name}")

        # Get next task
        task = client.tasks.next()
        if not task:
            print("No tasks available")
            return

        print(f"\nProcessing task: {task.title}")

        # Mark task as in progress
        client.tasks.update_status(task.id, TaskStatus.IN_PROGRESS)

        # Get task context
        context = client.tasks.context(task.id)

        # Create and run the crew
        crew = create_crew_for_task(client, task, context)
        result = crew.kickoff()

        print(f"\nCrew result: {result}")

        # Mark task for review
        client.tasks.update_status(task.id, TaskStatus.REVIEW)
        print("Task marked for review")

    finally:
        client.close()


if __name__ == "__main__":
    main()
