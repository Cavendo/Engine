"""
LangChain integration example for the Cavendo Python SDK.

This example shows how to use Cavendo Engine with LangChain to build
an AI agent that processes tasks and submits deliverables.

Requirements:
    pip install cavendo-engine langchain langchain-openai
"""

import asyncio
import os
from typing import Optional, Type

from cavendo import CavendoClient, TaskStatus, Task, TaskContext

# LangChain imports
try:
    from langchain.agents import AgentExecutor, create_openai_functions_agent
    from langchain.prompts import ChatPromptTemplate, MessagesPlaceholder
    from langchain.tools import BaseTool
    from langchain_openai import ChatOpenAI
    from pydantic import BaseModel, Field
except ImportError:
    print("LangChain not installed. Run: pip install langchain langchain-openai")
    raise


# Tool input schemas
class KnowledgeSearchInput(BaseModel):
    """Input schema for knowledge search."""

    query: str = Field(description="The search query to find relevant knowledge")


class SubmitDeliverableInput(BaseModel):
    """Input schema for submitting a deliverable."""

    title: str = Field(description="Title of the deliverable")
    content: str = Field(description="Full content of the deliverable in markdown format")


class UpdateTaskStatusInput(BaseModel):
    """Input schema for updating task status."""

    status: str = Field(
        description="New status: 'in_progress', 'review', or 'completed'"
    )


class CavendoKnowledgeSearchTool(BaseTool):
    """LangChain tool for searching Cavendo knowledge base."""

    name: str = "cavendo_knowledge_search"
    description: str = (
        "Search the Cavendo knowledge base for information relevant to your task. "
        "Returns summaries of matching documents."
    )
    args_schema: Type[BaseModel] = KnowledgeSearchInput

    client: CavendoClient
    project_id: Optional[int] = None

    class Config:
        arbitrary_types_allowed = True

    def _run(self, query: str) -> str:
        """Execute the knowledge search."""
        results = self.client.knowledge.search(
            query=query,
            project_id=self.project_id,
            limit=5,
        )

        if not results:
            return "No relevant knowledge documents found for your query."

        output_parts = []
        for i, result in enumerate(results, 1):
            doc = result.document
            output_parts.append(
                f"### Document {i}: {doc.title}\n"
                f"Relevance Score: {result.score:.2f}\n\n"
                f"{doc.content[:800]}{'...' if len(doc.content) > 800 else ''}"
            )

        return "\n\n---\n\n".join(output_parts)

    async def _arun(self, query: str) -> str:
        """Async version of the search."""
        results = await self.client.knowledge.search_async(
            query=query,
            project_id=self.project_id,
            limit=5,
        )

        if not results:
            return "No relevant knowledge documents found for your query."

        output_parts = []
        for i, result in enumerate(results, 1):
            doc = result.document
            output_parts.append(
                f"### Document {i}: {doc.title}\n"
                f"Relevance Score: {result.score:.2f}\n\n"
                f"{doc.content[:800]}{'...' if len(doc.content) > 800 else ''}"
            )

        return "\n\n---\n\n".join(output_parts)


class CavendoSubmitDeliverableTool(BaseTool):
    """LangChain tool for submitting deliverables to Cavendo."""

    name: str = "cavendo_submit_deliverable"
    description: str = (
        "Submit your completed work as a deliverable. "
        "Use this when you have finished your analysis or task work."
    )
    args_schema: Type[BaseModel] = SubmitDeliverableInput

    client: CavendoClient
    task_id: int

    class Config:
        arbitrary_types_allowed = True

    def _run(self, title: str, content: str) -> str:
        """Submit the deliverable."""
        deliverable = self.client.deliverables.submit(
            task_id=self.task_id,
            title=title,
            content=content,
            content_type="markdown",
            metadata={"source": "langchain_agent"},
        )
        return f"Successfully submitted deliverable '{title}' with ID: {deliverable.id}"

    async def _arun(self, title: str, content: str) -> str:
        """Async version of submit."""
        deliverable = await self.client.deliverables.submit_async(
            task_id=self.task_id,
            title=title,
            content=content,
            content_type="markdown",
            metadata={"source": "langchain_agent"},
        )
        return f"Successfully submitted deliverable '{title}' with ID: {deliverable.id}"


class CavendoUpdateStatusTool(BaseTool):
    """LangChain tool for updating task status."""

    name: str = "cavendo_update_task_status"
    description: str = (
        "Update the status of your current task. "
        "Use 'in_progress' when starting, 'review' when submitting for review."
    )
    args_schema: Type[BaseModel] = UpdateTaskStatusInput

    client: CavendoClient
    task_id: int

    class Config:
        arbitrary_types_allowed = True

    def _run(self, status: str) -> str:
        """Update the task status."""
        # Agents can only set in_progress or review; completed/cancelled are set by system
        valid_statuses = ["in_progress", "review"]
        if status not in valid_statuses:
            return f"Invalid status. Must be one of: {', '.join(valid_statuses)}"

        self.client.tasks.update_status(self.task_id, status)
        return f"Task status updated to: {status}"

    async def _arun(self, status: str) -> str:
        """Async version of status update."""
        # Agents can only set in_progress or review; completed/cancelled are set by system
        valid_statuses = ["in_progress", "review"]
        if status not in valid_statuses:
            return f"Invalid status. Must be one of: {', '.join(valid_statuses)}"

        await self.client.tasks.update_status_async(self.task_id, status)
        return f"Task status updated to: {status}"


def create_agent_for_task(
    client: CavendoClient,
    task: Task,
    context: TaskContext,
    llm: Optional[ChatOpenAI] = None,
) -> AgentExecutor:
    """
    Create a LangChain agent configured for a Cavendo task.
    """
    if llm is None:
        llm = ChatOpenAI(model="gpt-4", temperature=0)

    project_id = context.project.get("id") if context.project else None

    # Create tools
    tools = [
        CavendoKnowledgeSearchTool(client=client, project_id=project_id),
        CavendoSubmitDeliverableTool(client=client, task_id=task.id),
        CavendoUpdateStatusTool(client=client, task_id=task.id),
    ]

    # Build context information
    previous_deliverables = "\n".join(
        f"- {d.title}" for d in context.previous_deliverables
    ) or "None"

    related_knowledge = "\n".join(
        f"- {k.title}" for k in context.knowledge
    ) or "Use the knowledge search tool to find relevant information."

    # Create the prompt
    system_message = f"""You are an AI agent working on tasks from Cavendo Engine.

Current Task: {task.title}
Task ID: {task.id}
Priority: {task.priority}
Project: {context.project.get('name') if context.project else 'N/A'}

Task Description:
{task.description or 'No additional description provided.'}

Previous Deliverables for this task:
{previous_deliverables}

Available Knowledge:
{related_knowledge}

Your workflow should be:
1. First, update the task status to 'in_progress'
2. Search the knowledge base for relevant information
3. Analyze the findings and complete the task
4. Submit your deliverable with a clear title and comprehensive content
5. Update the task status to 'review'

Be thorough and professional in your analysis."""

    prompt = ChatPromptTemplate.from_messages([
        ("system", system_message),
        MessagesPlaceholder(variable_name="chat_history", optional=True),
        ("human", "{input}"),
        MessagesPlaceholder(variable_name="agent_scratchpad"),
    ])

    # Create the agent
    agent = create_openai_functions_agent(llm, tools, prompt)

    return AgentExecutor(
        agent=agent,
        tools=tools,
        verbose=True,
        handle_parsing_errors=True,
    )


def main() -> None:
    """Main function demonstrating LangChain integration."""

    # Initialize Cavendo client
    client = CavendoClient(
        url=os.getenv("CAVENDO_URL", "http://localhost:3001"),
        api_key=os.getenv("CAVENDO_AGENT_KEY"),
    )

    try:
        # Get agent info
        agent_info = client.me()
        print(f"Starting LangChain agent: {agent_info.name}")

        # Get next task
        task = client.tasks.next()
        if not task:
            print("No tasks available")
            return

        print(f"\nProcessing task: {task.title}")
        print(f"Description: {task.description}")

        # Get task context
        context = client.tasks.context(task.id)

        # Create the LangChain agent
        agent_executor = create_agent_for_task(client, task, context)

        # Run the agent
        result = agent_executor.invoke({
            "input": f"Please complete the following task: {task.title}"
        })

        print(f"\nAgent result: {result['output']}")

    finally:
        client.close()


async def main_async() -> None:
    """Async version of main for use with async LangChain patterns."""

    client = CavendoClient(
        url=os.getenv("CAVENDO_URL", "http://localhost:3001"),
        api_key=os.getenv("CAVENDO_AGENT_KEY"),
    )

    try:
        agent_info = await client.me_async()
        print(f"Starting async LangChain agent: {agent_info.name}")

        task = await client.tasks.next_async()
        if not task:
            print("No tasks available")
            return

        context = await client.tasks.context_async(task.id)
        agent_executor = create_agent_for_task(client, task, context)

        result = await agent_executor.ainvoke({
            "input": f"Please complete the following task: {task.title}"
        })

        print(f"\nAgent result: {result['output']}")

    finally:
        await client.aclose()


if __name__ == "__main__":
    # Use sync version by default
    main()

    # For async usage:
    # asyncio.run(main_async())
