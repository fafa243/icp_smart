import { query, update, text, Record, StableBTreeMap, Variant, Vec, None, Some, Ok, Err, ic, Principal, Opt, nat64, Duration, Result, bool, Canister } from "azle";
import {
    Ledger, binaryAddressFromAddress, binaryAddressFromPrincipal, hexAddressFromPrincipal
} from "azle/canisters/ledger";
import { hashCode } from "hashcode";
/**
 * This type represents a product that can be listed on a marketplace.
 * It contains basic properties that are needed to define a product.
 */


const Product = Record({
   id: text,
   title: text,
   description: text,
   location: text,
   price: nat64,
   seller: Principal,
   attachmentURL: text,
   soldAmount: nat64
});
const ProductPayload = Record({
   title: text,
   description: text,
   location: text,
   price: nat64,
   attachmentURL: text
});

const OrderStatus = Variant({
   PaymentPending: text,
   Completed: text
});

const Order = Record({
   productId: text,
   price: nat64,
   status: OrderStatus,
   seller: Principal,
   paid_at_block: Opt(nat64),
   memo: nat64
});

const Message = Variant({
   NotFound: text,
   InvalidPayload: text,
   PaymentFailed: text,
   PaymentCompleted: text
});

/**
 * `productsStorage` - it's a key-value data structure used to store products listed by sellers in the marketplace.
 * {@link StableBTreeMap} is a self-balancing tree acting as durable data storage that preserves data across canister upgrades.
 * For this contract, we've chosen {@link StableBTreeMap} for several reasons:
 * - `insert`, `get`, and `remove` operations have a constant time complexity of O(1).
 * - Data stored in this map persists across canister upgrades, unlike using a HashMap where data is stored in the heap and can be lost after a canister upgrade.
 */
const productsStorage = StableBTreeMap(text, Product, 0);
/**
 * `persistedOrders` and `pendingOrders` are also instances of {@link StableBTreeMap}.
 * These data structures are used to manage and store orders within the marketplace.
 */
const persistedOrders = StableBTreeMap(Principal, Order, 1);
const pendingOrders = StableBTreeMap(nat64, Order, 2);
/**
 * `ORDER_RESERVATION_PERIOD` is a constant that defines the reservation period for orders in seconds.
 * This period allows users to reserve products for a specific duration before completing the purchase.
 */
const ORDER_RESERVATION_PERIOD = 120n;

/**
 * Initialization of the Ledger canister, which handles financial transactions and ledger operations.
 * The principal text value is hardcoded here, as it is set in the `dfx.json` configuration.
 */
const icpCanister = Ledger(Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai"));

getProduct: query([text], Result(Product, Message), (id) => {
   const productOpt = productsStorage.get(id);
   if ("None" in productOpt) {
       return Err({ NotFound: `product with id=${id} not found` });
   }
   return Ok(productOpt.Some);
}),
   addProduct: update([ProductPayload], Result(Product, Message), (payload) => {
   if (typeof payload !== "object" || Object.keys(payload).length === 0) {
       return Err({ NotFound: "invalid payoad" })
   }
   const product = { id: uuidv4(), soldAmount: 0n, seller: ic.caller(), ...payload };
   productsStorage.insert(product.id, product);
   return Ok(product);
}),

   updateProduct: update([Product], Result(Product, Message), (payload) => {
   const productOpt = productsStorage.get(payload.id);
   if ("None" in productOpt) {
       return Err({ NotFound: `cannot update the product: product with id=${payload.id} not found` });
   }
   productsStorage.insert(productOpt.Some.id, payload);
   return Ok(payload);
}),
   deleteProduct: update([text], Result(text, Message), (id) => {
   const deletedProductOpt = productsStorage.remove(id);
   if ("None" in deletedProductOpt) {
       return Err({ NotFound: `cannot delete the product: product with id=${id} not found` });
   }
   return Ok(deletedProductOpt.Some.id);
}),

  /*
        on create order we generate a hashcode of the order and then use this number as corelation id (memo) in the transfer function
        the memo is later used to identify a payment for this particular order.

        The entire flow is divided into the three main parts:
            1. Create an order
            2. Pay for the order (transfer ICP to the seller). 
            3. Complete the order (use memo from step 1 and the transaction block from step 2)
            
        Step 2 is done on the FE app because we cannot create an order and transfer ICP in the scope of the single method. 
        When we call the `createOrder` method, the ic.caller() would the principal of the identity which initiated this call in the frontend app. 
        However, if we call `ledger.transfer()` from `createOrder` function, the principal of the original caller won't be passed to the 
        ledger canister when we make this call. 
        In this case, when we call `ledger.transfer()` from the `createOrder` method,
        the caller identity in the `ledger.transfer()` would be the principal of the canister from which we just made this call - in our case it's the marketplace canister.
        That's we split this flow into three parts.
    */
        createOrder: update([text], Result(Order, Message), (id) => {
         const productOpt = productsStorage.get(id);
         if ("None" in productOpt) {
             return Err({ NotFound: `cannot create the order: product=${id} not found` });
         }
         const product = productOpt.Some;
         const order = {
             productId: product.id,
             price: product.price,
             status: { PaymentPending: "PAYMENT_PENDING" },
             seller: product.seller,
             paid_at_block: None,
             memo: generateCorrelationId(id)
         };
         pendingOrders.insert(order.memo, order);
         discardByTimeout(order.memo, ORDER_RESERVATION_PERIOD);
         return Ok(order);
     }),
     completePurchase: update([Principal, text, nat64, nat64, nat64], Result(Order, Message), async (seller, id, price, block, memo) => {
      const paymentVerified = await verifyPaymentInternal(seller, price, block, memo);
      if (!paymentVerified) {
          return Err({ NotFound: `cannot complete the purchase: cannot verify the payment, memo=${memo}` });
      }
      const pendingOrderOpt = pendingOrders.remove(memo);
      if ("None" in pendingOrderOpt) {
          return Err({ NotFound: `cannot complete the purchase: there is no pending order with id=${id}` });
      }
      const order = pendingOrderOpt.Some;
      const updatedOrder = { ...order, status: { Completed: "COMPLETED" }, paid_at_block: Some(block) };
      const productOpt = productsStorage.get(id);
      if ("None" in productOpt) {
          throw Error(`product with id=${id} not found`);
      }
      const product = productOpt.Some;
      product.soldAmount += 1n;
      productsStorage.insert(product.id, product);
      persistedOrders.insert(ic.caller(), updatedOrder);
      return Ok(updatedOrder);
  }),
 /*
        another example of a canister-to-canister communication
        here we call the `query_blocks` function on the ledger canister
        to get a single block with the given number `start`.
        The `length` parameter is set to 1 to limit the return amount of blocks.
        In this function we verify all the details about the transaction to make sure that we can mark the order as completed
    */
        verifyPayment: query([Principal, nat64, nat64, nat64], bool, async (receiver, amount, block, memo) => {
         return await verifyPaymentInternal(receiver, amount, block, memo);
     }),
     
         // not used right now. can be used for transfers from the canister for instances when a marketplace can hold a balance account for users
         makePayment: update([text, nat64], Result(Message, Message), async (to, amount) => {
         const toPrincipal = Principal.fromText(to);
         const toAddress = hexAddressFromPrincipal(toPrincipal, 0);
         const transferFeeResponse = await ic.call(icpCanister.transfer_fee, { args: [{}] });
         const transferResult = ic.call(icpCanister.transfer, {
             args: [{
                 memo: 0n,
                 amount: {
                     e8s: amount
                 },
                 fee: {
                     e8s: transferFeeResponse.transfer_fee.e8s
                 },
                 from_subaccount: None,
                 to: binaryAddressFromAddress(toAddress),
                 created_at_time: None
             }]
         });
         if ("Err" in transferResult) {
             return Err({ PaymentFailed: `payment failed, err=${transferResult.Err}` })
         }
         return Ok({ PaymentCompleted: "payment completed" });
     });
/*
    a hash function that is used to gene/*
    a hash function that is used to generate correlation ids for orders.
    also, we use that in the verifyPayment function where we check if the used has actually paid the order
*/
function hash(input: any): nat64 {
   return BigInt(Math.abs(hashCode().value(input)));
};

// a workaround to make uuid package work with Azle
globalThis.crypto = {
   // @ts-ignore
   getRandomValues: () => {
       let array = new Uint8Array(32);

       for (let i = 0; i < array.length; i++) {
           array[i] = Math.floor(Math.random() * 256);
       }

       return array;
   }
};

function generateCorrelationId(productId: text): nat64 {
   const correlationId = `${productId}_${ic.caller().toText()}_${ic.time()}`;
   return hash(correlationId);
};

/*
   after the order is created, we give the `delay` amount of minutes to pay for the order.
   if it's not paid during this timeframe, the order is automatically removed from the pending orders.
*/
function discardByTimeout(memo: nat64, delay: Duration) {
   ic.setTimer(delay, () => {
       const order = pendingOrders.remove(memo);
       console.log(`Order discarded ${order}`);
   });
}
function hash(input: any): nat64 {
   return BigInt(Math.abs(hashCode().value(input)));
};

// a workaround to make uuid package work with Azle
globalThis.crypto = {
   // @ts-ignore
   getRandomValues: () => {
       let array = new Uint8Array(32);

       for (let i = 0; i < array.length; i++) {
           array[i] = Math.floor(Math.random() * 256);
       }

       return array;
   }
};

function generateCorrelationId(productId: text): nat64 {
   const correlationId = `${productId}_${ic.caller().toText()}_${ic.time()}`;
   return hash(correlationId);
};

/*
   after the order is created, we give the `delay` amount of minutes to pay for the order.
   if it's not paid during this timeframe, the order is automatically removed from the pending orders.
*/
function discardByTimeout(memo: nat64, delay: Duration) {
   ic.setTimer(delay, () => {
       const order = pendingOrders.remove(memo);
       console.log(`Order discarded ${order}`);
   });
};
async function verifyPaymentInternal(receiver: Principal, amount: nat64, block: nat64, memo: nat64): Promise<bool> {
   const blockData = await ic.call(icpCanister.query_blocks, { args: [{ start: block, length: 1n }] });
   const tx = blockData.blocks.find((block) => {
       if ("None" in block.transaction.operation) {
           return false;
       }
       const operation = block.transaction.operation.Some;
       const senderAddress = binaryAddressFromPrincipal(ic.caller(), 0);
       const receiverAddress = binaryAddressFromPrincipal(receiver, 0);
       return block.transaction.memo === memo &&
           hash(senderAddress) === hash(operation.Transfer?.from) &&
           hash(receiverAddress) === hash(operation.Transfer?.to) &&
           amount === operation.Transfer?.amount.e8s;
   });
   return tx ? true : false;
};

     
