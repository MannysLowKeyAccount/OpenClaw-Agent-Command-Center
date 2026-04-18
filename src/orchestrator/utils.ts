import type { TaskFlowDefinition, TaskFlowStep, WorkflowExecutionRecord } from "./types.js";

/**
 * The single common tool ID used by all task flows.
 */
export const TASK_FLOW_TOOL_ID = "run_task_flow";

/**
 * Derives the file name for a flow's generated artifact.
 * Only the .flow.ts file is generated now (no more .tool.ts per flow).
 * @example deriveFileNames("coding_pipeline") => { flowFile: "coding_pipeline.flow.ts" }
 */
export function deriveFileNames(flowName: string): { flowFile: string } {
    return {
        flowFile: flowName + ".flow.ts",
    };
}

const FLOW_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/**
 * Validates a TaskFlowDefinition, checking name format, step presence,
 * non-empty step ids/agentIds, and unique step ids.
 */
export function validateFlowDefinition(flow: TaskFlowDefinition): { valid: boolean; error?: string } {
    if (!FLOW_NAME_PATTERN.test(flow.name)) {
        return { valid: false, error: "Flow name must match ^[a-zA-Z][a-zA-Z0-9_]*$" };
    }

    if (!flow.steps || flow.steps.length === 0) {
        return { valid: false, error: "Flow must have at least one step" };
    }

    for (let i = 0; i < flow.steps.length; i++) {
        const step = flow.steps[i];
        if (!step.id || step.id.trim() === "") {
            return { valid: false, error: `Step ${i + 1} has an empty id` };
        }
        if (!step.agentId || step.agentId.trim() === "") {
            return { valid: false, error: `Step ${i + 1} has an empty agentId` };
        }
    }

    const ids = new Set<string>();
    for (const step of flow.steps) {
        if (ids.has(step.id)) {
            return { valid: false, error: `Duplicate step id: ${step.id}` };
        }
        ids.add(step.id);
    }

    return { valid: true };
}

/**
 * Swaps the step at `index` with the step at `index - 1`.
 * No-op if index === 0. Returns a new array (immutable).
 */
export function moveStepUp(steps: TaskFlowStep[], index: number): TaskFlowStep[] {
    if (index <= 0 || index >= steps.length) {
        return [...steps];
    }
    const result = [...steps];
    const temp = result[index - 1];
    result[index - 1] = result[index];
    result[index] = temp;
    return result;
}

/**
 * Swaps the step at `index` with the step at `index + 1`.
 * No-op if index === last. Returns a new array (immutable).
 */
export function moveStepDown(steps: TaskFlowStep[], index: number): TaskFlowStep[] {
    if (index < 0 || index >= steps.length - 1) {
        return [...steps];
    }
    const result = [...steps];
    const temp = result[index + 1];
    result[index + 1] = result[index];
    result[index] = temp;
    return result;
}

/**
 * Adds `toolId` to `alsoAllow` only if not already present.
 * Returns a new array.
 */
export function addToolToAlsoAllow(alsoAllow: string[], toolId: string): string[] {
    if (alsoAllow.includes(toolId)) {
        return [...alsoAllow];
    }
    return [...alsoAllow, toolId];
}

/**
 * Sorts workflow execution records: running/waiting before completed/failed,
 * newest first (by startedAt descending) within each group.
 * Returns a new sorted array.
 */
export function sortExecutions(records: WorkflowExecutionRecord[]): WorkflowExecutionRecord[] {
    const isActive = (r: WorkflowExecutionRecord) => r.state === "running" || r.state === "waiting";
    return [...records].sort((a, b) => {
        const aActive = isActive(a);
        const bActive = isActive(b);
        if (aActive !== bActive) {
            return aActive ? -1 : 1;
        }
        return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
    });
}
