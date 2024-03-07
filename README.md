# Smart contract weather
This weather website provides extensive and in-depth weather information, not only monitoring weather conditions in the local area, but also covering a wider area up to the national level. By integrating sensor data, users can access the latest weather updates not only relevant to the micro-conditions around them, but also provide a holistic insight into atmospheric conditions across the nation. 

## Key feature
1. **Temperature:**
   Measuring overall air and water temperature provides a holistic, multi-faceted perspective, enabling a deeper understanding of temperature trends in a broader scope.
2. **Rainfall:**
   Detecting potential upcoming rainfall in the vicinity is a proactive effort in obtaining weather information to mitigate its impact.
3. **Rain time:**
   Using up-to-date weather data, the system is able to detect when rainfall will begin and provide an estimated time until it ends.

### Installation
* Clone the repository
```bash
 git clone https://github.com/Kevinsweep/wishlist.git
```
* Install dependencies
```bash
 npm install
```
* install `dfx`
```bash
 DFX_VERSION=0.15.0 sh -ci "$(curl -fsSL https://sdk.dfinity.org/install.sh)"
 dfx start --background
```

### Internet identity canister

`dfx deploy internet_identity` - that is the canister that handles the authentication flow. Once it's deployed, the `js-agent` library will be talking to it to register identities. There is UI that acts as a wallet where you can select existing identities
or create a new one.

### Marketplace canister

`dfx deploy dfinity_js_backend` - deploys the marketplace canister where the business logic is implemented.
Basically, it implements functions like add, view, update, delete, and buy products + a set of helper functions.

Do not forget to run `dfx generate dfinity_js_backend` anytime you add/remove functions in the canister or when you change the signatures.
Otherwise, these changes won't be reflected in IDL's and won't work when called using the JS agent.

### Marketplace frontend canister
`dfx deploy dfinity_js_frontend` - deployes the frontend app for the `dfinity_js_backend` canister on IC.
