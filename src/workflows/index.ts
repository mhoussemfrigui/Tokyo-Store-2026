/**
 * Workflow registry — single import surface for Server Actions / API routes.
 *
 * Pattern:
 *   import { workflows } from "@/workflows";
 *   const result = await workflows.auth.signin(input, { ip });
 */

import { signupWorkflow } from "./auth/signup";
import { signinWorkflow } from "./auth/signin";
import { signoutWorkflow } from "./auth/signout";
import { requestPasswordResetWorkflow } from "./auth/request-password-reset";
import { resetPasswordWorkflow } from "./auth/reset-password";
import { verifyEmailWorkflow } from "./auth/verify-email";
import { inviteUserWorkflow } from "./auth/invite-user";
import { createUserWorkflow } from "./auth/create-user";
import { setPasswordWorkflow } from "./auth/set-password";
import { setEmailWorkflow } from "./auth/set-email";
import {
  disableUserWorkflow,
  enableUserWorkflow,
  forceLogoutWorkflow,
  setEmailVerifiedWorkflow,
} from "./auth/disable-user";
import {
  createRoleWorkflow,
  deleteRoleWorkflow,
  updateRoleWorkflow,
} from "./rbac/manage-roles";
import { setUserRolesWorkflow } from "./rbac/assign-roles";
import { setUserPermissionsWorkflow } from "./rbac/set-user-permissions";

import { adminUpdateProfileWorkflow, updateProfileWorkflow } from "./customer/update-profile";
import { addAddressWorkflow } from "./customer/add-address";
import { updateAddressWorkflow } from "./customer/update-address";
import { deleteAddressWorkflow } from "./customer/delete-address";
import { setDefaultAddressWorkflow } from "./customer/set-default-address";
import { updateCustomerNotesWorkflow } from "./customer/update-notes";
import { deleteCustomerWorkflow } from "./customer/delete-customer";
import { upsertCustomerFromApiWorkflow } from "./customer/upsert-from-api";

import {
  createBrandWorkflow,
  deleteBrandWorkflow,
  reorderBrandsWorkflow,
  updateBrandWorkflow,
} from "./catalog/create-brand";
import {
  createCategoryWorkflow,
  deleteCategoryWorkflow,
  reorderCategoriesWorkflow,
  updateCategoryWorkflow,
} from "./catalog/create-category";
import {
  createCarePlanWorkflow,
  deleteCarePlanWorkflow,
  updateCarePlanWorkflow,
} from "./catalog/care";
import {
  createProductWorkflow,
  deleteProductWorkflow,
  updateProductWorkflow,
} from "./catalog/create-product";
import { duplicateProductWorkflow } from "./catalog/duplicate-product";
import { upsertProductVariantsWorkflow } from "./catalog/upsert-product-variants";
import {
  createReviewWorkflow,
  setReviewStatusWorkflow,
  deleteReviewWorkflow,
  createManualReviewWorkflow,
  deleteReviewsBySourceWorkflow,
} from "./catalog/review";
import {
  bulkAssignAttributesWorkflow,
  createAttributeWorkflow,
  createValueWorkflow,
  deleteAttributeWorkflow,
  deleteValueWorkflow,
  setAttributeCategoriesWorkflow,
  setCategoryFiltersWorkflow,
  setValueOrderWorkflow,
  updateAttributeWorkflow,
  updateValueWorkflow,
} from "./catalog/manage-attributes";

import {
  deleteMediaWorkflow,
  updateMediaWorkflow,
  uploadMediaWorkflow,
} from "./media/upload-media";
import { importMediaFromUrlWorkflow } from "./media/import-url";
import { updateMediaSettingsWorkflow } from "./media/settings";

import {
  createTrustBadgeWorkflow,
  deleteTrustBadgeWorkflow,
  updateTrustBadgeWorkflow,
} from "./cms/trust-badge";
import {
  upsertBrandFaqsWorkflow,
  upsertCategoryFaqsWorkflow,
  upsertProductFaqsWorkflow,
} from "./cms/faq";
import { upsertSettingWorkflow, upsertSettingsBatchWorkflow } from "./cms/setting";
import {
  createBannerWorkflow,
  deleteBannerWorkflow,
  setNavFeaturedWorkflow,
  updateBannerWorkflow,
} from "./cms/banner";
import {
  createPageWorkflow,
  deletePageWorkflow,
  savePageBlocksWorkflow,
  togglePagePublishWorkflow,
  updatePageWorkflow,
} from "./cms/page";
import {
  createNavItemWorkflow,
  createNavMenuWorkflow,
  deleteNavItemWorkflow,
  updateNavItemWorkflow,
  updateNavMenuWorkflow,
} from "./cms/navigation";

import {
  addToCartWorkflow,
  removeCartItemWorkflow,
  setCartItemQuantityWorkflow,
  setCartItemCarePlanWorkflow,
} from "./cart/add-to-cart";

import { placeOrderWorkflow } from "./order/place-order";
import { placeQuickOrderWorkflow } from "./order/place-quick-order";
import { transitionOrderStatusWorkflow } from "./order/transition-status";
import { setOrderPaymentStatusWorkflow } from "./order/set-order-payment-status";
import { confirmOrderWorkflow } from "./order/confirm-order";
import { setOrderPaymentReferenceWorkflow } from "./order/set-payment-reference";
import { setOrderInvoiceTaxWorkflow } from "./order/set-invoice-tax";
import { refundOrderWorkflow } from "./order/refund-order";
import { switchOrderToCodWorkflow } from "./order/switch-to-cod";
import { setOrderSpamWorkflow } from "./order/set-spam";
import {
  createWarrantyClaimWorkflow,
  updateWarrantyClaimWorkflow,
  resolveWarrantyClaimWorkflow,
} from "./order/warranty-claims";
import { linkGuestOrderWorkflow } from "./order/link-guest-order";
import {
  confirmPaymentWorkflow,
  initiatePaymentWorkflow,
} from "./order/gateway-payment";
import { reconcilePendingPaymentsWorkflow } from "./order/reconcile-pending-payments";
import { sweepAbandonedOrdersWorkflow } from "./order/sweep-abandoned-orders";
import {
  createReturnWorkflow,
  receiveReturnWorkflow,
  rejectReturnWorkflow,
} from "./order/returns";
import { editOrderItemsWorkflow } from "./order/edit-items";
import { createShipmentWorkflow } from "./order/create-shipment";
import { createOrderFromLinesWorkflow } from "./order/create-from-lines";
import { setOrderExternalRefWorkflow } from "./order/set-external-ref";

import {
  createBlogCategoryWorkflow,
  deleteBlogCategoryWorkflow,
  updateBlogCategoryWorkflow,
} from "./blog/category";
import {
  createBlogPostWorkflow,
  deleteBlogPostWorkflow,
  restoreBlogPostWorkflow,
  togglePostPublishWorkflow,
  updateBlogPostWorkflow,
} from "./blog/post";
import { createTagWorkflow, deleteTagWorkflow, updateTagWorkflow } from "./blog/tag";

import {
  createAuthorWorkflow,
  updateAuthorWorkflow,
  deleteAuthorWorkflow,
  restoreAuthorWorkflow,
} from "./authors/author";

import {
  submitBlogCommentWorkflow,
  setBlogCommentStatusWorkflow,
  deleteBlogCommentWorkflow,
} from "./blog_comments/comment";


import { importDemoWorkflow } from "./demo/import-demo";
import { clearDemoWorkflow } from "./demo/clear-demo";

import { subscribeWorkflow } from "./newsletter/subscribe";
import { reactivateSubscriberWorkflow } from "./newsletter/reactivate";

import { purgeAuditWorkflow } from "./audit/purge";
import { purgeSearchLogWorkflow } from "./search/purge-log";

import {
  createPromotionWorkflow,
  deletePromotionWorkflow,
  duplicatePromotionWorkflow,
  evaluatePromotionWorkflow,
  togglePromotionActiveWorkflow,
  updatePromotionWorkflow,
} from "./promotion";

import { upsertPaymentProviderSettingsWorkflow } from "./payment/upsert-provider-settings";
import { upsertAiProviderSettingsWorkflow } from "./ai/upsert-provider-settings";
import { upsertAiFeaturePromptsWorkflow } from "./ai/upsert-feature-prompts";
import { setShowcasePinsWorkflow } from "./showcase/set-pins";
import { deleteTaxRuleWorkflow, upsertTaxRuleWorkflow } from "./tax/rule";
import {
  createDeliveryAgentWorkflow,
  deleteDeliveryAgentWorkflow,
  updateDeliveryAgentWorkflow,
} from "./delivery/agent";
import {
  createPickupLocationWorkflow,
  deletePickupLocationWorkflow,
  updatePickupLocationWorkflow,
} from "./delivery/location";

export const workflows = {
  auth: {
    signup: signupWorkflow,
    signin: signinWorkflow,
    signout: signoutWorkflow,
    requestPasswordReset: requestPasswordResetWorkflow,
    resetPassword: resetPasswordWorkflow,
    verifyEmail: verifyEmailWorkflow,
    inviteUser: inviteUserWorkflow,
    createUser: createUserWorkflow,
    setPassword: setPasswordWorkflow,
    setEmail: setEmailWorkflow,
    disableUser: disableUserWorkflow,
    enableUser: enableUserWorkflow,
    forceLogout: forceLogoutWorkflow,
    setEmailVerified: setEmailVerifiedWorkflow,
  },
  rbac: {
    createRole: createRoleWorkflow,
    updateRole: updateRoleWorkflow,
    deleteRole: deleteRoleWorkflow,
    setUserRoles: setUserRolesWorkflow,
    setUserPermissions: setUserPermissionsWorkflow,
  },
  customer: {
    upsertFromApi: upsertCustomerFromApiWorkflow,
    updateProfile: updateProfileWorkflow,
    adminUpdateProfile: adminUpdateProfileWorkflow,
    addAddress: addAddressWorkflow,
    updateAddress: updateAddressWorkflow,
    deleteAddress: deleteAddressWorkflow,
    setDefaultAddress: setDefaultAddressWorkflow,
    updateNotes: updateCustomerNotesWorkflow,
    deleteCustomer: deleteCustomerWorkflow,
  },
  catalog: {
    createBrand: createBrandWorkflow,
    updateBrand: updateBrandWorkflow,
    deleteBrand: deleteBrandWorkflow,
    reorderBrands: reorderBrandsWorkflow,
    createCategory: createCategoryWorkflow,
    updateCategory: updateCategoryWorkflow,
    deleteCategory: deleteCategoryWorkflow,
    reorderCategories: reorderCategoriesWorkflow,
    createCarePlan: createCarePlanWorkflow,
    updateCarePlan: updateCarePlanWorkflow,
    deleteCarePlan: deleteCarePlanWorkflow,
    createProduct: createProductWorkflow,
    updateProduct: updateProductWorkflow,
    deleteProduct: deleteProductWorkflow,
    duplicateProduct: duplicateProductWorkflow,
    upsertProductVariants: upsertProductVariantsWorkflow,
    createAttribute: createAttributeWorkflow,
    updateAttribute: updateAttributeWorkflow,
    deleteAttribute: deleteAttributeWorkflow,
    createAttributeValue: createValueWorkflow,
    updateAttributeValue: updateValueWorkflow,
    deleteAttributeValue: deleteValueWorkflow,
    bulkAssignAttributes: bulkAssignAttributesWorkflow,
    setCategoryFilters: setCategoryFiltersWorkflow,
    setValueOrder: setValueOrderWorkflow,
    setAttributeCategories: setAttributeCategoriesWorkflow,
    review: {
      create: createReviewWorkflow,
      setStatus: setReviewStatusWorkflow,
      delete: deleteReviewWorkflow,
      createManual: createManualReviewWorkflow,
      deleteBySource: deleteReviewsBySourceWorkflow,
    },
  },
  media: {
    upload: uploadMediaWorkflow,
    importFromUrl: importMediaFromUrlWorkflow,
    update: updateMediaWorkflow,
    delete: deleteMediaWorkflow,
    updateSettings: updateMediaSettingsWorkflow,
  },
  cms: {
    createTrustBadge: createTrustBadgeWorkflow,
    updateTrustBadge: updateTrustBadgeWorkflow,
    deleteTrustBadge: deleteTrustBadgeWorkflow,
    upsertProductFaqs: upsertProductFaqsWorkflow,
    upsertCategoryFaqs: upsertCategoryFaqsWorkflow,
    upsertBrandFaqs: upsertBrandFaqsWorkflow,
    upsertSetting: upsertSettingWorkflow,
    upsertSettingsBatch: upsertSettingsBatchWorkflow,
    createBanner: createBannerWorkflow,
    updateBanner: updateBannerWorkflow,
    deleteBanner: deleteBannerWorkflow,
    setNavFeatured: setNavFeaturedWorkflow,
    createPage: createPageWorkflow,
    updatePage: updatePageWorkflow,
    savePageBlocks: savePageBlocksWorkflow,
    togglePagePublish: togglePagePublishWorkflow,
    deletePage: deletePageWorkflow,
    createNavMenu: createNavMenuWorkflow,
    updateNavMenu: updateNavMenuWorkflow,
    createNavItem: createNavItemWorkflow,
    updateNavItem: updateNavItemWorkflow,
    deleteNavItem: deleteNavItemWorkflow,
  },
  cart: {
    add: addToCartWorkflow,
    setQuantity: setCartItemQuantityWorkflow,
    setCarePlan: setCartItemCarePlanWorkflow,
    remove: removeCartItemWorkflow,
  },
  order: {
    place: placeOrderWorkflow,
    placeQuick: placeQuickOrderWorkflow,
    transitionStatus: transitionOrderStatusWorkflow,
    setPaymentStatus: setOrderPaymentStatusWorkflow,
    confirm: confirmOrderWorkflow,
    setPaymentReference: setOrderPaymentReferenceWorkflow,
    setInvoiceTax: setOrderInvoiceTaxWorkflow,
    refund: refundOrderWorkflow,
    switchToCod: switchOrderToCodWorkflow,
    setSpam: setOrderSpamWorkflow,
    linkGuestOrder: linkGuestOrderWorkflow,
    initiatePayment: initiatePaymentWorkflow,
    confirmPayment: confirmPaymentWorkflow,
    reconcilePendingPayments: reconcilePendingPaymentsWorkflow,
    sweepAbandonedOrders: sweepAbandonedOrdersWorkflow,
    createReturn: createReturnWorkflow,
    receiveReturn: receiveReturnWorkflow,
    rejectReturn: rejectReturnWorkflow,
    editItems: editOrderItemsWorkflow,
    createShipment: createShipmentWorkflow,
    createFromLines: createOrderFromLinesWorkflow,
    setExternalRef: setOrderExternalRefWorkflow,
  },
  warranty: {
    createClaim: createWarrantyClaimWorkflow,
    updateClaim: updateWarrantyClaimWorkflow,
    resolveClaim: resolveWarrantyClaimWorkflow,
  },
  blog: {
    createCategory: createBlogCategoryWorkflow,
    updateCategory: updateBlogCategoryWorkflow,
    deleteCategory: deleteBlogCategoryWorkflow,
    createPost: createBlogPostWorkflow,
    updatePost: updateBlogPostWorkflow,
    togglePostPublish: togglePostPublishWorkflow,
    deletePost: deleteBlogPostWorkflow,
    restorePost: restoreBlogPostWorkflow,
    createTag: createTagWorkflow,
    updateTag: updateTagWorkflow,
    deleteTag: deleteTagWorkflow,
  },
  authors: {
    create: createAuthorWorkflow,
    update: updateAuthorWorkflow,
    delete: deleteAuthorWorkflow,
    restore: restoreAuthorWorkflow,
  },
  blogComments: {
    submit: submitBlogCommentWorkflow,
    setStatus: setBlogCommentStatusWorkflow,
    delete: deleteBlogCommentWorkflow,
  },
  demo: {
    import: importDemoWorkflow,
    clear: clearDemoWorkflow,
  },
  newsletter: {
    subscribe: subscribeWorkflow,
    reactivate: reactivateSubscriberWorkflow,
  },
  audit: {
    purge: purgeAuditWorkflow,
  },
  search: {
    purgeLog: purgeSearchLogWorkflow,
  },
  promotion: {
    create: createPromotionWorkflow,
    update: updatePromotionWorkflow,
    delete: deletePromotionWorkflow,
    toggleActive: togglePromotionActiveWorkflow,
    duplicate: duplicatePromotionWorkflow,
    evaluate: evaluatePromotionWorkflow,
  },
  payment: {
    upsertProviderSettings: upsertPaymentProviderSettingsWorkflow,
  },
  ai: {
    upsertProviderSettings: upsertAiProviderSettingsWorkflow,
    upsertFeaturePrompts: upsertAiFeaturePromptsWorkflow,
  },
  showcase: {
    setPins: setShowcasePinsWorkflow,
  },
  tax: {
    upsertRule: upsertTaxRuleWorkflow,
    deleteRule: deleteTaxRuleWorkflow,
  },
  delivery: {
    createAgent: createDeliveryAgentWorkflow,
    updateAgent: updateDeliveryAgentWorkflow,
    deleteAgent: deleteDeliveryAgentWorkflow,
    createLocation: createPickupLocationWorkflow,
    updateLocation: updatePickupLocationWorkflow,
    deleteLocation: deletePickupLocationWorkflow,
  },
} as const;
