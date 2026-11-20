package io.temporal.demo.springai.workflows;

import io.temporal.demo.springai.model.OpenInvestmentAccountInput;
import io.temporal.demo.springai.model.OpenInvestmentAccountOutput;
import io.temporal.demo.springai.model.WealthManagementClient;
import io.temporal.workflow.QueryMethod;
import io.temporal.workflow.SignalMethod;
import io.temporal.workflow.UpdateMethod;
import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import java.util.Map;

/** One account opening: KYC, compliance approval, then a saga. Its names are the shared Temporal contract. */
@WorkflowInterface
public interface OpenInvestmentAccountWorkflow {
    @WorkflowMethod(name = "OpenInvestmentAccountWorkflow")
    OpenInvestmentAccountOutput run(OpenInvestmentAccountInput inputs);

    @QueryMethod(name = "get_current_state")
    String getCurrentState();

    @UpdateMethod(name = "get_client_details")
    WealthManagementClient getClientDetails();

    @UpdateMethod(name = "update_client_details")
    String updateClientDetails(Map<String, Object> clientDetails);

    @SignalMethod(name = "verify_kyc")
    void verifyKyc();

    @SignalMethod(name = "compliance_approved")
    void complianceApproved();
}
