import { trace, type Tracer } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

export interface TracingOptions {
  serviceName: string;
  otlpEndpoint?: string;
  environment?: string;
}

let sdkInstance: NodeSDK | null = null;
let isTracingActive = false;

/**
 * Initializes distributed tracing with OpenTelemetry.
 * Tracing is activated only if an OTLP endpoint is provided or configured in `OTEL_EXPORTER_OTLP_ENDPOINT`.
 * If no endpoint is set, tracing remains safely inactive without crashing.
 */
export function initializeTracing(options: TracingOptions): boolean {
  if (sdkInstance || isTracingActive) {
    return isTracingActive;
  }

  const endpoint = options.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  if (!endpoint) {
    // Tracing disabled / inactive
    return false;
  }

  try {
    const serviceName = options.serviceName || process.env.OTEL_SERVICE_NAME || "astra-service";
    const environment = options.environment || process.env.NODE_ENV || "development";

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      "deployment.environment": environment,
    });

    const traceExporter = new OTLPTraceExporter({
      url: endpoint.endsWith("/v1/traces") ? endpoint : `${endpoint.replace(/\/+$/, "")}/v1/traces`,
    });

    sdkInstance = new NodeSDK({
      resource,
      traceExporter,
    });

    sdkInstance.start();
    isTracingActive = true;
    return true;
  } catch (error) {
    console.error("Failed to initialize OpenTelemetry tracing:", error);
    sdkInstance = null;
    isTracingActive = false;
    return false;
  }
}

/**
 * Returns whether tracing is currently active.
 */
export function isTracingEnabled(): boolean {
  return isTracingActive;
}

/**
 * Gets a tracer instance for manual span instrumentation.
 */
export function getTracer(name = "astra"): Tracer {
  return trace.getTracer(name);
}

/**
 * Gracefully shuts down the OpenTelemetry SDK.
 * Resolves cleanly without throwing even if tracing was never initialized.
 */
export async function shutdownTracing(): Promise<void> {
  if (sdkInstance) {
    try {
      await sdkInstance.shutdown();
    } catch (err) {
      console.error("Error shutting down OpenTelemetry tracing:", err);
    } finally {
      sdkInstance = null;
      isTracingActive = false;
    }
  }
}

